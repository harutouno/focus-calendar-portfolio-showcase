import AsyncStorage from "@react-native-async-storage/async-storage";
import { AIRequestKind } from "@/types/ai";
import { STORAGE_KEYS } from "./keys";
import { isOwnerScopeVisible } from "./ownerScope";
import { isNonEmptyString, isPlainObject, isString, isValidIsoDateTimeString } from "./shapeGuards";

/** 未完了のAI依頼（送信中〜サーバー確定前）を再現するために必要な最小限の情報。 */
export interface PersistedAiPendingRequest {
  requestId: string;
  kind: AIRequestKind;
  input: string;
  createdAt: string; // ISO8601
  /**
   * SEC-F006-001残存修正: この依頼を開始した時点の認証ユーザーID。未ログイン
   * （ゲスト・ローカルAI利用）で開始された場合は明示的にnull。この項目自体が
   * 無い旧形式データは「所有者不明」として扱い、nullとは区別する
   * （isOwnerScopeVisible()参照。誰にも復元させない）。
   */
  ownerUserId?: string | null;
}

const AI_REQUEST_KINDS: readonly AIRequestKind[] = [
  "create_schedule",
  "suggest_schedule",
  "focus_analysis",
  "feature_help",
];

/**
 * DATA-F002-002: 従来はJSON.parse成功後、実際の形を一切確認せず`as`キャストしていた
 * （唯一検証していたのはJSON構文そのものの正しさのみ）。requestId/kindが壊れていると
 * 誤ったrequestIdの再利用・利用回数の二重消費につながりうるため、この関数だけは
 * 他のRepositoryと違い、不正な形状も「読み込み失敗」と同じ扱いでthrowする
 * （このファイル全体の既存方針：自動的に新規requestIdへフォールバックしない）。
 */
function isValidPersistedAiPendingRequest(value: unknown): value is PersistedAiPendingRequest {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.requestId)) return false;
  if (!(AI_REQUEST_KINDS as readonly string[]).includes(value.kind as string)) return false;
  if (!isString(value.input)) return false;
  if (!isValidIsoDateTimeString(value.createdAt)) return false;
  if (value.ownerUserId !== undefined && value.ownerUserId !== null && !isNonEmptyString(value.ownerUserId)) {
    return false;
  }
  return true;
}

/**
 * P0052 (QA-F007-C19最終): ゲスト（未ログイン）所有の行を格納するmap key。
 * 実際のuserId（Supabase認証のUUID）とは形式的に衝突しない固定文字列。
 */
const GUEST_OWNER_SCOPE = "__guest__";

function ownerScopeOf(ownerUserId: string | null): string {
  return ownerUserId === null ? GUEST_OWNER_SCOPE : ownerUserId;
}

/**
 * P0052 (QA-F007-C19最終): v2形式の永続化スキーマ。同じstorage keyの下で、
 * 所有者（userId、またはゲストはGUEST_OWNER_SCOPE）ごとに独立したrowを持つ。
 * これにより、A→B→Aのようにマウント中に所有者が切り替わっても、互いのrequestIdを
 * 上書き・削除しない（P0051まではrowが1件のみのためoverwriteが起きていた）。
 * `sessionInstanceId`はscopeへ含めない（同一userの新セッションへも同じrequestIdを
 * 復元させるため。stale応答のrender-adoption防止はP0050のidentityKey gateが別途担う）。
 */
interface AiPendingRequestStoreV2 {
  version: 2;
  owners: Record<string, PersistedAiPendingRequest>;
}

function isValidStoreV2(value: unknown): value is AiPendingRequestStoreV2 {
  if (!isPlainObject(value)) return false;
  if (value.version !== 2) return false;
  return isPlainObject(value.owners);
}

/**
 * P0052: 単独のrowだけが直接保存されている旧形式（P0051以前）。v2導入前の端末に
 * 残り得るデータで、`version`フィールドを持たない。
 */
function isLegacyFlatRow(value: unknown): value is PersistedAiPendingRequest {
  return isValidPersistedAiPendingRequest(value);
}

/**
 * [P0126 DATA-F073-007 / 008b] 保存済みの生値を**4状態に分離**して解釈する。
 *
 * ```text
 * missing        : キー未保存（正当な初回状態）
 * malformed      : JSON構文として壊れている
 * unknown-schema : JSONとしては読めるが、v2 mapでもlegacy rowでもない
 * value          : 認識できるスキーマ
 * ```
 *
 * 特に `unknown-schema` を `malformed` と同一視してはならない。
 * 将来版が書いた新スキーマ（downgrade後の起動など）はJSONとしては完全に正常で、
 * 他所有者の**実在する**pending requestを保持している可能性がある。これを
 * 「理解できない＝復元不能＝破棄してよい」と扱うと、現在requestだけを持つ
 * 新しいstoreで上書きし、他所有者のrequestIdを消してしまう
 * （＝二重消費・課金済みリクエストの喪失につながる）。
 * forward/backward compatibility上、unknown schemaは**保護対象**である。
 *
 * I/Oエラーはここへ来ない（呼び出し元の`getItem`が非ラップでrejectを伝播するため、
 * 既にfail-closed）。この関数はその契約を変えない。
 */
type AiPendingStoreShape =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "unknown-schema" }
  | { kind: "v2"; store: AiPendingRequestStoreV2 }
  | { kind: "legacy"; row: PersistedAiPendingRequest };

function classifyStoredShape(raw: string | null): AiPendingStoreShape {
  if (raw == null) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  if (isValidStoreV2(parsed)) return { kind: "v2", store: parsed };
  if (isLegacyFlatRow(parsed)) return { kind: "legacy", row: parsed };
  return { kind: "unknown-schema" };
}

/**
 * 破損・未知スキーマを表す共通エラー（raw SyntaxErrorを外へ出さない: DATA-F073-008b）。
 *
 * [P0128 DATA-F073-008a 再指摘] `target-row-unusable` を追加。
 * ストア全体はv2として妥当でも、**削除対象scopeのrowだけが**壊れている／所有者不明／
 * 所有者矛盾のとき、以前は黙ってresolveしていた。対象のAI pendingバイト列が
 * 残ったまま成功扱いにならないよう、読めない状態は明示的にエラーにする。
 */
export class AiPendingRequestUnreadableError extends Error {
  constructor(readonly reason: "malformed" | "unknown-schema" | "target-row-unusable") {
    super(`aiPendingRequest_unreadable: ${reason}`);
    this.name = "AiPendingRequestUnreadableError";
  }
}

/**
 * 単独最終修正(2026-08): 未完了AIリクエストの永続化。
 *
 * 他のRepository（src/storage/storage.tsのreadJSON/writeJSON）は読み書き失敗を握りつぶし、
 * 安全なfallback値を返す設計だが、このデータに限ってそれを踏襲しない。保存済みの
 * requestIdを読み落として「無かったこと」にすると、そのまま新規requestIdの発行・
 * 二重消費につながるため、読み込み・保存・削除の失敗は呼び出し側
 * （useAISupportRequest）へそのまま伝播させ、「復元できない」ことを明示的に
 * 扱わせる（自動的に新規依頼として握りつぶさない）。
 *
 * SEC-F006-001残存修正: currentUserIdは「今、この端末で有効な認証ユーザーID
 * （未ログインならnull）」。所有者スコープの判定自体はisOwnerScopeVisible()に集約し、
 * 「ownerUserIdが無い（旧形式・所有者不明）」「明示的にnull（ゲスト）」「文字列（本人）」の
 * 3状態を区別する（詳細は同関数のコメントを参照）。
 *
 * P0052 (QA-F007-C19最終): 保存先をowner-partitioned（v2 map）へ変更。同じstorage keyに
 * 旧形式（単独row）が残っている場合、それが「今のcurrentUserId本人のもの」であれば
 * この呼び出しの中でv2形式へ移行して返す（module-level lockの中で読み直し・書き戻す）。
 * 他人の旧形式rowはここでは一切書き換えない（消さない・採用しない）。
 */
export async function getPendingAiRequest(
  currentUserId: string | null = null
): Promise<PersistedAiPendingRequest | null> {
  const scope = ownerScopeOf(currentUserId);
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.aiPendingRequest);
  const shape = classifyStoredShape(raw);
  if (shape.kind === "missing") return null;
  if (shape.kind === "malformed" || shape.kind === "unknown-schema") {
    // [P0126 DATA-F073-008b] 以前は素の`JSON.parse`がraw SyntaxErrorを投げていた。
    // fail-closedである点（＝「pendingなし」に化けない）は元から正しいため、
    // 安全境界は変えず、error taxonomyだけを他のstorage authorityへ揃える。
    throw new AiPendingRequestUnreadableError(shape.kind);
  }
  const parsed: unknown = shape.kind === "v2" ? shape.store : shape.row;

  if (isValidStoreV2(parsed)) {
    const row = parsed.owners[scope];
    if (row === undefined) return null;
    if (!isValidPersistedAiPendingRequest(row)) {
      throw new Error("aiPendingRequest_invalid_shape");
    }
    if (!isOwnerScopeVisible(row.ownerUserId, currentUserId)) {
      // scope（map key）だけでなく、row自身のownerUserIdでも再確認する。通常の
      // savePendingAiRequestはscopeをownerUserIdから導出するため一致するはずだが、
      // ownerUserIdを省略して保存された所有者不明rowがゲストscopeに紛れ込んでいた
      // 場合、それは誰にも復元させない（P0051以前と同じ「所有者不明は復元しない」方針）。
      return null;
    }
    return row;
  }

  if (isLegacyFlatRow(parsed)) {
    if (!isOwnerScopeVisible(parsed.ownerUserId, currentUserId)) {
      // 他人（または所有者不明）の旧形式row。採用しない・消さない。
      return null;
    }
    // 自分自身の旧形式row。v2形式へ移行してから返す。lock内で読み直し、
    // その間に別のsave/clearが割り込んでいないか確認してから書き戻す。
    return withPendingRequestLock(async () => {
      const freshRaw = await AsyncStorage.getItem(STORAGE_KEYS.aiPendingRequest);
      // [P0128 DATA-F073-007/008b 再指摘] 以前はここだけ素の`JSON.parse`で読み直しており、
      // 分類器(`classifyStoredShape`)の権威を迂回していた。結果として
      //   - 2回目の読み取りがmalformedだと raw SyntaxError がそのまま外へ出る（008b）
      //   - 2回目がunknown schemaだと `null`（=pendingなし）へ落ちる（007）
      // という2つの穴が残っていた。unknown schemaは「不在」ではなく保護対象の権威なので、
      // 1回目と同じ分類器・同じ語彙で扱う。
      const freshShape = classifyStoredShape(freshRaw);
      if (freshShape.kind === "missing") return null;
      if (freshShape.kind === "malformed" || freshShape.kind === "unknown-schema") {
        throw new AiPendingRequestUnreadableError(freshShape.kind);
      }
      if (freshShape.kind === "v2") {
        const row = freshShape.store.owners[scope];
        if (row === undefined) return null;
        if (!isValidPersistedAiPendingRequest(row)) {
          throw new AiPendingRequestUnreadableError("target-row-unusable");
        }
        if (!isOwnerScopeVisible(row.ownerUserId, currentUserId)) return null;
        return row;
      }
      // freshShape.kind === "legacy"
      if (!isOwnerScopeVisible(freshShape.row.ownerUserId, currentUserId)) return null;
      const migrated: AiPendingRequestStoreV2 = { version: 2, owners: { [scope]: freshShape.row } };
      await AsyncStorage.setItem(STORAGE_KEYS.aiPendingRequest, JSON.stringify(migrated));
      return freshShape.row;
    });
  }

  throw new Error("aiPendingRequest_invalid_shape");
}

/**
 * P0051 (QA-F007-C19): このファイル内の全mutation（save・conditional clear）を
 * module-level single-writerキューへ直列化する。異なる所有者間の完全な並列化は
 * 不要なため、単一queueのままでよい（P0052でも維持）。
 *
 * error safety: 個々のoperationがthrow/rejectしても、そのエラーは呼び出し元へ
 * そのまま伝播する（catchして握りつぶさない）一方、キュー自体は次のoperationへ
 * 進む（「poison」しない）。retryは行わない（無限リトライ無し、1回失敗したら
 * 呼び出し元の責任）。
 */
let pendingRequestWriteQueue: Promise<void> = Promise.resolve();

function withPendingRequestLock<T>(operation: () => Promise<T>): Promise<T> {
  const resultPromise = pendingRequestWriteQueue.then(operation, operation);
  // 次のoperationが必ず実行されるよう、キュー自体は常にresolvedへ正規化する
  // （このoperationがthrow/rejectしても、次のenqueueはブロックされない）。
  pendingRequestWriteQueue = resultPromise.then(
    () => undefined,
    () => undefined
  );
  return resultPromise;
}

/**
 * P0052: 保存先はowner-partitioned（v2 map）。既存内容がv2 mapならそのまま
 * 自分のscopeだけを追加/置換する。既存内容が旧形式（単独row）の場合、それが
 * 別の所有者のものである可能性があるため、いきなり上書きせず、その所有者自身の
 * scopeへ運んでからv2 mapへ移行し、その上で自分のscopeを追加/置換する
 * （＝別所有者のまだ未移行のrequestIdを、自分のsaveのついでに消してしまわない）。
 * [P0128 §6 コメント修正] ここには以前「既存内容が壊れている場合は破棄し、自分のscopeのみを
 * 持つ新しいv2 mapを書き込む」と書かれていたが、**P0126 DATA-F073-007 以降その記述は
 * 実装と矛盾している**。現在は malformed / unknown-schema のいずれでも書き込まず、
 * `AiPendingRequestUnreadableError` で失敗させて生のバイト列をそのまま保持する
 * （下の実装内コメントも参照）。
 */
export async function savePendingAiRequest(request: PersistedAiPendingRequest): Promise<void> {
  return withPendingRequestLock(async () => {
    const scope = ownerScopeOf(request.ownerUserId ?? null);
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.aiPendingRequest);
    const shape = classifyStoredShape(raw);
    let owners: Record<string, PersistedAiPendingRequest> = {};
    if (shape.kind === "malformed" || shape.kind === "unknown-schema") {
      // [P0126 DATA-F073-007] 以前はここで「復元不能なので破棄」として空のownersから
      // 書き直していた。malformedはともかく、unknown-schemaは他所有者の実在する
      // pending requestを含み得るため、現在requestで上書きしてはならない。
      // どちらも書き込まずに失敗させ、生の値をそのまま保持する。
      throw new AiPendingRequestUnreadableError(shape.kind);
    }
    if (shape.kind === "v2") {
      // 個々のrowが不正でもそのまま引き継ぐ（正規化して落とさない）。
      owners = { ...shape.store.owners };
    } else if (shape.kind === "legacy") {
      const legacyScope = ownerScopeOf(shape.row.ownerUserId ?? null);
      owners = { [legacyScope]: shape.row };
    }
    owners[scope] = request;
    const next: AiPendingRequestStoreV2 = { version: 2, owners };
    await AsyncStorage.setItem(STORAGE_KEYS.aiPendingRequest, JSON.stringify(next));
  });
}

/**
 * P0052 (QA-F007-C19最終): ownerUserIdを必須のauthorityにする（criteria無しの
 * 全所有者無条件削除は撤去 — production呼び出し元は全て所有者を明示できるため）。
 * expectedRequestIdを省略した場合は所有者一致のみで削除する。
 *
 * 一致を確認できない場合（他所有者のrow、内容が壊れている、期待した所有者/requestIdと
 * 不一致等）は安全側として削除しない（他のrowには一切触れない）。
 *
 * savePendingAiRequestと同じmodule-level queueへ直列化されるため、
 * 「読み込み→比較→削除」の間に別のsave/clearが割り込むことはない。
 */
export async function clearPendingAiRequest(criteria: {
  ownerUserId: string | null;
  expectedRequestId?: string;
}): Promise<void> {
  return withPendingRequestLock(async () => {
    const scope = ownerScopeOf(criteria.ownerUserId);
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.aiPendingRequest);
    const shape = classifyStoredShape(raw);
    if (shape.kind === "missing") return;
    if (shape.kind === "malformed" || shape.kind === "unknown-schema") {
      // [P0126 DATA-F073-008a] 以前はcatchして黙ってreturnしていた（＝成功として解決）。
      // 以前は黙って成功扱いにしていたため、読めない値を残したまま処理済みと
      // 誤認する余地があった。呼び出し元に失敗として返して再試行可能にする。
      throw new AiPendingRequestUnreadableError(shape.kind);
    }
    const parsed: unknown = shape.kind === "v2" ? shape.store : shape.row;

    if (isValidStoreV2(parsed)) {
      const row = parsed.owners[scope];
      // 対象scopeが存在しない = 消すものが無い。正常にresolveしてよい。
      if (row === undefined) return;
      // [P0128 DATA-F073-008a 再指摘] 以前はここで黙ってreturn（=削除成功として解決）して
      // いたが、対象scopeのバイト列は残ったままだった。安全に検証・帰属できない対象を
      // 盲目的に削除しないのは正しい一方、それを「削除できた」と報告してはならない。
      // 生の値は書き換えず、rejectして呼び出し元に再試行の余地を残す。
      if (!isValidPersistedAiPendingRequest(row)) {
        throw new AiPendingRequestUnreadableError("target-row-unusable");
      }
      // scope（map key）だけでなく、row自身のownerUserIdでも再確認する（getPendingAiRequestと
      // 同じ理由：ownerUserIdを省略して保存された所有者不明rowをclearの対象にしない）。
      if (row.ownerUserId === undefined || row.ownerUserId !== criteria.ownerUserId) {
        throw new AiPendingRequestUnreadableError("target-row-unusable");
      }
      // requestId不一致は「別のより新しいリクエストに置き換わっていた」という
      // 条件付きclearの正当なno-opであり、破損でも帰属不能でもない。よってresolveする。
      if (criteria.expectedRequestId !== undefined && row.requestId !== criteria.expectedRequestId) return;
      const nextOwners = { ...parsed.owners };
      delete nextOwners[scope];
      const next: AiPendingRequestStoreV2 = { version: 2, owners: nextOwners };
      await AsyncStorage.setItem(STORAGE_KEYS.aiPendingRequest, JSON.stringify(next));
      return;
    }

    if (isLegacyFlatRow(parsed)) {
      // 旧形式rowの所有者不明（ownerUserId自体が無い）行は誰のclearでも対象にしない
      // （P0051以前と同じ方針：所有者不明データは削除対象にも復元対象にもしない）。
      if (parsed.ownerUserId === undefined || parsed.ownerUserId !== criteria.ownerUserId) return;
      if (criteria.expectedRequestId !== undefined && parsed.requestId !== criteria.expectedRequestId) return;
      await AsyncStorage.removeItem(STORAGE_KEYS.aiPendingRequest);
      return;
    }
    // 認識できない内容は安全側として何もしない。
  });
}
