import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "./keys";
import {
  isNonEmptyString,
  isPlainObject,
  isString,
  isStringArray,
  isValidIsoDateTimeString,
  StoredDataValidationError,
} from "./shapeGuards";
import { generateId } from "@/utils/id";

export type BulkAttemptState = "pending" | "committed" | "queued" | "no_commit";

/**
 * [P0080 DATA-F017-001] 一括作成（期間・曜日指定）の論理的なattemptの永続記録。
 * 重要: access_token・SharedMutationAuthSnapshot等の認証情報を運ぶための項目は
 * この型に一切存在しない（意図的——このrepositoryは「どのidをどの日付に割り当てたか」
 * だけを記憶する。認証はAppDataContext.saveEventsBulk呼び出しの都度、既存の
 * captureSharedMutationAuthSnapshotが別途・毎回新しく取得する）。
 */
export interface BulkAttemptRecord {
  attemptId: string;
  /** ローカル（デバイス内）カレンダー宛ての一括作成はnull。共有カレンダー宛てはuserId。 */
  ownerUserId: string | null;
  calendarId: string;
  fingerprint: string;
  recurringGroupId: string;
  /** previewDatesと同じ順序。datesと1:1対応する。 */
  eventIds: string[];
  dates: string[];
  state: BulkAttemptState;
  createdAt: string;
  updatedAt: string;
}

function isValidBulkAttemptRecord(value: unknown): value is BulkAttemptRecord {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.attemptId)) return false;
  if (value.ownerUserId !== null && !isNonEmptyString(value.ownerUserId)) return false;
  if (!isNonEmptyString(value.calendarId)) return false;
  if (!isString(value.fingerprint)) return false;
  if (!isNonEmptyString(value.recurringGroupId)) return false;
  if (!isStringArray(value.eventIds) || value.eventIds.length === 0) return false;
  if (!isStringArray(value.dates) || value.dates.length !== value.eventIds.length) return false;
  if (!["pending", "committed", "queued", "no_commit"].includes(value.state as string)) return false;
  if (!isValidIsoDateTimeString(value.createdAt)) return false;
  if (!isValidIsoDateTimeString(value.updatedAt)) return false;
  return true;
}

/**
 * [P0080 DATA-F017-001] 無制限な蓄積を避けるための緩やかな上限。
 * [P0082 DATA-F017-003] 以前はこの上限を超えると、実際には全レコードが常にpending
 * （resolveBulkAttemptが確定済みレコードを即座に削除するため、保存されている限り
 * 必ずpending＝未解決）であるにも関わらず、updatedAt最古のものを無条件に
 * 追い出していた——「無制限な蓄積の防止」を「未解決のidempotency authority喪失防止」
 * より優先してしまっていた（正本の禁止事項）。上限判定はbeginOrResumeBulkAttempt側
 * （新規発行の直前）へ移し、この関数自体はもう一切のtrim/evictを行わない
 * （常に渡された配列をそのまま書き込む）。
 */
const MAX_RECORDS = 20;

function ownerScope(ownerUserId: string | null): string {
  return ownerUserId ?? "__local__";
}

/**
 * [P0082 DATA-F017-003] beginOrResumeBulkAttemptが新規attemptを拒否した際に投げる、
 * 判別可能な例外。呼び出し元（BulkEventForm.tsx）は既存の汎用catch（Alert表示）で
 * 自然に処理できるが、原因を明示できるよう専用のerror classにする。
 */
export class BulkAttemptJournalCapacityError extends Error {
  constructor() {
    super("bulk_attempt_journal_capacity_exceeded");
    this.name = "BulkAttemptJournalCapacityError";
  }
}

/**
 * [P0084 DATA-F017-004] 同じ所有者・同じ対象カレンダーに未解決(pending)のattemptが
 * 既に存在する場合、beginOrResumeBulkAttemptが新規発行を拒否した際に投げる、
 * 判別可能な例外。理由は2種類:
 *   - "dates_mismatch": fingerprintは一致するが、保存済みattemptのdatesと
 *     今回のdatesが食い違う（環境差等で同じ入力からも異なる日程が導出された、
 *     極めて稀なケース）。
 *   - "different_attempt_pending": fingerprintそのものが異なる（＝ユーザーが
 *     未解決のattemptがある状態でフォームの内容を変更してから再送した）。
 * どちらの場合も、結果が不明な前回attemptを暗黙に見捨てて新しいID組で送信すると、
 * 前回のリクエストが実はサーバー側で既にコミット済みだった場合に重複を生む
 * （正本§5「Do not automatically delete the old attempt」）。
 */
export class BulkAttemptJournalConflictError extends Error {
  constructor(public readonly reason: "dates_mismatch" | "different_attempt_pending") {
    super("bulk_attempt_journal_conflict");
    this.name = "BulkAttemptJournalConflictError";
  }
}

/**
 * [P0082 DATA-F017-003] このjournalはidempotency authority（「同じ内容の再送に同じidを
 * 割り当ててよいか」の唯一の根拠）そのものであるため、他の多くのCategory C相当の
 * repositoryとは異なり、部分的に壊れた要素だけを黙って除外して継続することを禁じる
 * （除外＝そのattemptのid再利用可能性を静かに失うことであり、安全側ではなく
 * 危険側の判断になる——同じ内容が実は既にコミット済みでも、除外されたことで
 * 「初見」として新しいidで再送され、重複を生みうる）。既存のStoredDataValidationError
 * 規約（eventsRepository.ts・syncQueueRepository.ts等と同じ）にそのまま合わせ、
 * 壊れたJSON・トップレベル非配列・1件でも不正な要素があれば例外を投げる
 * （生のAsyncStorageバイト列は一切書き換えない・writeAllは呼ばない）。
 * beginOrResumeBulkAttemptはこの例外を伝播させ、呼び出し元（BulkEventForm.handleSubmit）
 * はonSave（実際のネットワーク送信）より前のtry内でこれをawaitしているため、
 * journal authorityを安全に読めなかった場合はonSaveへ一切進まない。
 */
async function readAll(): Promise<BulkAttemptRecord[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.bulkAttemptJournal);
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoredDataValidationError("bulkAttemptJournal", "invalid_json");
  }
  if (!Array.isArray(parsed)) {
    throw new StoredDataValidationError("bulkAttemptJournal", "not_array");
  }
  const invalidCount = parsed.filter((el) => !isValidBulkAttemptRecord(el)).length;
  if (invalidCount > 0) {
    throw new StoredDataValidationError("bulkAttemptJournal", `${invalidCount}_malformed_records`);
  }
  return parsed as BulkAttemptRecord[];
}

async function writeAll(records: BulkAttemptRecord[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.bulkAttemptJournal, JSON.stringify(records));
}

/**
 * [P0080 DATA-F017-001] このファイル内の全mutationを単一queueへ直列化する
 * （aiPendingRequestRepository.tsと同じ確立済みパターン）。
 */
let writeQueue: Promise<void> = Promise.resolve();

function withLock<T>(operation: () => Promise<T>): Promise<T> {
  const resultPromise = writeQueue.then(operation, operation);
  writeQueue = resultPromise.then(
    () => undefined,
    () => undefined
  );
  return resultPromise;
}

/**
 * 同じ所有者・同じfingerprintのpending attemptがあれば、それをそのまま返す
 * （＝同一内容の再送でid再利用）。無ければ新規に発行して永続化してから返す。
 * 「見つける→無ければ作る」を1つのlock区間で行うため、同時に2回呼ばれても
 * （理論上、UIのsubmittingRefにより実際には起きない想定だが防御的に）同じ
 * fingerprintに対して2つのattemptが作られることはない。
 *
 * [P0084 DATA-F017-004] 以前は「同じowner+fingerprintのpendingが無ければ
 * （dates不一致で見つからなかった場合も含めて）常に新規attemptを発行する」設計だった。
 * これは、同じowner+対象カレンダーに未解決(pending)のattemptが既にある状態で
 * fingerprintが変わった（＝内容を変更してから再送した）場合、結果不明の前回attemptを
 * 暗黙に見捨てて新しいID組で送信してしまう——前回のリクエストが実はサーバー側で
 * 既にコミット済みだった場合、重複を生む（正本の禁止事項）。calendarIdも含めた
 * owner+calendar scope内に未解決attemptが1件でもあれば、fingerprintの一致・不一致を
 * 問わずまず確認し、新規発行を許可する前にブロックする。
 */
export async function beginOrResumeBulkAttempt(input: {
  ownerUserId: string | null;
  calendarId: string;
  fingerprint: string;
  dates: string[];
}): Promise<BulkAttemptRecord> {
  return withLock(async () => {
    const all = await readAll();
    const scope = ownerScope(input.ownerUserId);
    // [P0084 DATA-F017-004] 同じowner+対象カレンダーの範囲内で、未解決(pending)の
    // attemptを1件でも探す（fingerprintは問わない——他のカレンダー宛ての未解決
    // attemptは無関係、同じ所有者の同じカレンダー宛てだけが競合しうる）。
    const pendingInScope = all.find(
      (r) =>
        ownerScope(r.ownerUserId) === scope &&
        r.calendarId === input.calendarId &&
        r.state === "pending"
    );
    if (pendingInScope) {
      if (pendingInScope.fingerprint === input.fingerprint) {
        // [P0080 DATA-F017-001] datesの件数・順序が保存済みattemptと一致する場合のみ
        // 再利用する。
        if (
          pendingInScope.dates.length === input.dates.length &&
          pendingInScope.dates.every((d, i) => d === input.dates[i])
        ) {
          return pendingInScope;
        }
        // 同じfingerprintだが日付が食い違う（同じ文言・日程設定からgetDatesInRangeByWeekday
        // の計算結果が環境差等で変わった等、極めて稀）。以前はここで無条件に新規attemptを
        // 発行していたが、それは前回attemptの結果不明のままの見捨てに当たる。
        // 新規発行せず・onSaveへも進まず、明示的な競合として呼び出し元へ伝える
        // （journalの元のレコードは一切変更しない）。
        throw new BulkAttemptJournalConflictError("dates_mismatch");
      }
      // fingerprintが異なる＝内容を変更してから再送した。未解決の前回attemptを
      // 暗黙に見捨てて新しいfingerprintで送信することを許さない。
      throw new BulkAttemptJournalConflictError("different_attempt_pending");
    }
    // [P0082 DATA-F017-003] 上限に達している場合、既存の未解決pendingレコードを
    // 一切削除せず、新規発行そのものを拒否する（idempotency authorityを失わないことを、
    // 無制限な蓄積の防止より優先する）。全レコードは保存されている限り常にpending
    // （resolveBulkAttemptが確定済みレコードを即座に削除するため）であり、
    // 「無条件に最古を追い出す」旧実装は必ず未解決authorityを破壊していた。
    if (all.length >= MAX_RECORDS) {
      throw new BulkAttemptJournalCapacityError();
    }
    const now = new Date().toISOString();
    const record: BulkAttemptRecord = {
      attemptId: generateId("bulkattempt"),
      ownerUserId: input.ownerUserId,
      calendarId: input.calendarId,
      fingerprint: input.fingerprint,
      recurringGroupId: generateId("recur"),
      eventIds: input.dates.map(() => generateId("evt")),
      dates: input.dates,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await writeAll([...all, record]);
    return record;
  });
}

/**
 * attemptの結果が判明した時点で呼ぶ。"committed"（ローカル/共有への確定保存が成功）・
 * "queued"（オフライン同期キューへ確実に積めた——以後の耐久性の責任はキュー側に
 * 移る）のいずれも、このjournal自体の役目は終わるためレコードを削除する。
 * "no_commit"（バリデーション拒否・恒久的な権限エラー等、どこにも一切書き込まれ
 * なかったことが確実な失敗）も同様に削除し、次の送信を新規attemptとして扱えるようにする。
 * それ以外（例外の握りつぶし・呼び出し忘れ）の場合はレコードがpendingのまま残り、
 * 次回同じfingerprintでの再送がこのレコードのid組を再利用する
 * （＝「不明な結果」を安全側でid再利用可能な状態として扱う、この関数の主目的）。
 */
export async function resolveBulkAttempt(
  attemptId: string,
  ownerUserId: string | null,
  outcome: Exclude<BulkAttemptState, "pending">
): Promise<void> {
  return withLock(async () => {
    const all = await readAll();
    const scope = ownerScope(ownerUserId);
    const next = all.filter(
      (r) => !(r.attemptId === attemptId && ownerScope(r.ownerUserId) === scope)
    );
    void outcome; // 状態名は呼び出し元のログ・テストの意図表明用。永続化側では「削除」のみで表現する。
    await writeAll(next);
  });
}

/** テスト・診断用。本番コードパスからは呼ばない。 */
export async function listBulkAttemptsForOwner(ownerUserId: string | null): Promise<BulkAttemptRecord[]> {
  const all = await readAll();
  const scope = ownerScope(ownerUserId);
  return all.filter((r) => ownerScope(r.ownerUserId) === scope);
}
