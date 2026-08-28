import * as Crypto from "expo-crypto";
import { supabase } from "@/lib/supabaseClient";
import {
  PendingSharedCalendarCreate,
  clearPendingSharedCalendarCreate,
  classifySharedCalendarCreateAdoption,
  resolveSharedCalendarCreateResumeMode,
  wasSharedCalendarCreateStartedInThisRun,
  putPendingSharedCalendarCreate,
  readPendingSharedCalendarCreates,
} from "@/storage/sharedCalendarCreateJournalRepository";
import {
  CalendarInvite,
  CalendarMembership,
  CalendarRole,
  JoinedCalendarSummary,
  MemberPreview,
  PendingInvite,
  SharedCalendar,
  SharedCalendarMemberLimitStatus,
} from "@/types/sharing";
import {
  SharedMutationIdentity,
  SharedOperationIdentity,
  awaitCurrentSharedOperation,
  runCurrentSharedMutation,
} from "@/auth/sharedMutationIdentity";
import {
  captureSharedMutationAuthSnapshot,
  createPinnedSharedClient,
  withPinnedSharedClient,
} from "@/auth/sharedMutationAuthSnapshot";
import {
  SHARED_CALENDAR_LEAVE_BLOCKED_MESSAGE,
  SHARED_CALENDAR_LEAVE_UNCONFIRMED_MESSAGE,
  SHARED_MEMBER_WRITE_BLOCKED_MESSAGE,
  SHARED_MEMBER_WRITE_UNCONFIRMED_MESSAGE,
  WriteEffectOutcome,
  classifyZeroRowEffect,
} from "@/services/writeEffectAuthority";
import { normalizeInviteRecipient } from "@/utils/inviteAuthority";

// 呼び出し元（画面・テスト）が calendarService から一貫して参照できるよう再輸出する。
export {
  SHARED_CALENDAR_LEAVE_BLOCKED_MESSAGE,
  SHARED_CALENDAR_LEAVE_UNCONFIRMED_MESSAGE,
  SHARED_MEMBER_WRITE_BLOCKED_MESSAGE,
  SHARED_MEMBER_WRITE_UNCONFIRMED_MESSAGE,
};

/** RPC が `returns table(...)` の場合、supabase-js は行配列を返す。先頭 1 行を取り出す。 */
function firstRow<T>(data: unknown): T | undefined {
  if (Array.isArray(data)) return data[0] as T | undefined;
  return (data ?? undefined) as T | undefined;
}

interface CalendarRow {
  id: string;
  name: string;
  color: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  calendar_id: string;
  user_id: string;
  role: CalendarRole;
  profiles?: { display_name: string | null } | null;
}

/** 一覧画面のアバター表示用に先頭何名分のプレビューを持たせるか */
const MAX_MEMBER_PREVIEW = 4;

function rowToCalendar(row: CalendarRow): SharedCalendar {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ログイン中ユーザーが参加している共有カレンダー一覧（自分の権限つき）。
 * REVISE対応（第11ラウンド、P1-1）: 内部で3回Supabaseへ通信するため、各await境界の直後
 * （次の通信を開始する前・最終的な結果を返す前）に`identity`を再検証する。開始時点では
 * 現在のidentityだった呼び出しでも、1回目の通信待機中にidentityが切り替わっていれば、
 * その時点で得た`calendarIds`を使った2回目・3回目の通信をBのセッション下で開始しない
 * （最終的にreducer側で結果が捨てられるとしても、クロスidentity通信自体を発生させない）。
 *
 * REVISE対応（P0014 Batch1.1、P1-1）: 各Supabase呼び出しを`awaitCurrentSharedOperation`へ
 * 通す（共有データアクセスで共通の呼出し規約：operation内部で
 * `if (error) throw error`し、`awaitCurrentSharedOperation`自身のcatchがstaleを
 * 「元エラーを投げる前」に必ず優先する）。以前は`if (error) throw error`を先に評価して
 * いたため、A→B切替とremote errorが同時に起きると通常のremote errorがstaleより先に
 * 漏れてしまっていた。同一identityのままなら、元のresolved値・元のerrorはどちらも
 * 一切変更せずそのまま維持する。
 */
export async function fetchJoinedCalendars(
  identity: SharedOperationIdentity
): Promise<JoinedCalendarSummary[]> {
  const memberRows = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase
      .from("calendar_members")
      .select("calendar_id, role")
      .eq("user_id", identity.userId);
    if (error) throw error;
    return data;
  });
  if (!memberRows || memberRows.length === 0) return [];

  const calendarIds = memberRows.map((m) => m.calendar_id);
  const calendarRows = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase
      .from("calendars")
      .select("id, name, color, owner_id, created_at, updated_at")
      .in("id", calendarIds);
    if (error) throw error;
    return data;
  });

  const allMembers = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase
      .from("calendar_members")
      .select("calendar_id, user_id, profiles(display_name)")
      .in("calendar_id", calendarIds);
    if (error) throw error;
    return data;
  });

  const memberCountByCalendar = new Map<string, number>();
  const memberPreviewsByCalendar = new Map<string, MemberPreview[]>();
  for (const m of (allMembers ?? []) as unknown as MemberRow[]) {
    memberCountByCalendar.set(
      m.calendar_id,
      (memberCountByCalendar.get(m.calendar_id) ?? 0) + 1
    );
    const previews = memberPreviewsByCalendar.get(m.calendar_id) ?? [];
    if (previews.length < MAX_MEMBER_PREVIEW) {
      previews.push({
        userId: m.user_id,
        displayName: m.profiles?.display_name ?? undefined,
      });
      memberPreviewsByCalendar.set(m.calendar_id, previews);
    }
  }
  const roleByCalendar = new Map(memberRows.map((m) => [m.calendar_id, m.role]));

  return (calendarRows as CalendarRow[]).map((row) => ({
    calendar: rowToCalendar(row),
    role: roleByCalendar.get(row.id) ?? "viewer",
    memberCount: memberCountByCalendar.get(row.id) ?? 1,
    memberPreviews: memberPreviewsByCalendar.get(row.id) ?? [],
  }));
}

/**
 * [P0134 QA-F021 / DATA-F021-001] 共有カレンダー作成の再判定結果（4状態）。
 *
 * `0 rows` と `SELECT失敗` を絶対に同一視しない（QA-F073 で固めた
 * `missing != I/O error` と同じ原則）。さらに「行はあるが中身が違う」を
 * APPLIED に混ぜず `conflict` として独立させる。
 */
export type SharedCalendarCreateReconcileOutcome =
  | { kind: "applied"; calendar: SharedCalendar }
  | { kind: "absent-now" }
  | { kind: "conflict"; reason: "payload_mismatch"; row: SharedCalendar }
  | { kind: "unknown"; error: unknown };

/**
 * 同じ calendarId の行が存在するのに、その内容が pending intent と一致しない
 * （または存在するのに自分には見えない）ため、再送しても正しくならないことが確定した状態。
 *
 * メッセージは機械可読なコードのみ。`toFriendlyMessage` に対応表を持たせないので、
 * UI では既存の汎用 fallback 文言がそのまま使われる（新しい文言を一切増やさない）。
 */
export class SharedCalendarCreateConflictError extends Error {
  readonly reason: "payload_mismatch" | "id_taken_but_invisible";

  constructor(reason: "payload_mismatch" | "id_taken_but_invisible") {
    super(`shared_calendar_create_conflict: ${reason}`);
    this.name = "SharedCalendarCreateConflictError";
    this.reason = reason;
  }
}

/**
 * operation identity（= クライアント生成の `calendars.id`）を発行する。
 * 値を作れなかった場合は**リクエストを送る前に**失敗させる。
 * ここで曖昧な値のまま INSERT すると、サーバ既定の `gen_random_uuid()` で
 * 採番されてしまい、再判定不能な unknown outcome を再び作ることになる。
 */
function newCalendarOperationId(): string {
  const id = Crypto.randomUUID();
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("shared_calendar_create_operation_id_unavailable");
  }
  return id;
}

/**
 * [P0137 §3] 破壊的な journal 削除を許可してよい **終局** outcome かどうか。
 * `absent-now`（0 rows）と `unknown` は非終局であり、単独では削除権限にならない。
 */
export function isTerminalSharedCalendarCreateOutcome(
  outcome: SharedCalendarCreateReconcileOutcome
): boolean {
  return outcome.kind === "applied" || outcome.kind === "conflict";
}

/**
 * このプロセスで既に結果が確定した operation identity。
 *
 * 成功確定後の journal 削除が**書込み失敗した**場合、durable な痕跡だけでは
 * 「未解決の pending」と区別できない（区別する手段そのものが失敗しているため）。
 * そのまま放置すると、ユーザーが意図的に同じ名前・同じ色でもう1件作ろうとしたときに
 * 「既存の1件を返して終わり」になり得る。プロセス内メモリで確定済みを覚えておけば、
 * 現実に起こり得る「続けてもう1件作る」操作ではその誤りが起きない
 * （新しい永続状態は増やさない。再起動を跨ぐ残存は下記の既知の限界）。
 */
const resolvedCreateOperationIds = new Set<string>();

/**
 * [P0139 §5 / COVERAGE-F021-009] **いま実行中の** create が握っている operation identity。
 *
 * `SHARED_CALENDAR_CREATE_CONCURRENCY_RULE = INDEPENDENT_CREATES / NO_COALESCING`
 *
 * journal の pending 採用（resume / recover-only）は「応答喪失で **既に終わった**
 * 呼び出しのリトライ」のための仕組みである。ところが採用条件が
 * 「owner + run + name/color fingerprint」だけだと、**まだ実行中の別呼び出し**が
 * 書いた pending も採用対象になってしまう。その結果:
 *   - ユーザーが意図的に出した2件目の作成要求が、1件目の結果へすり替わる（false-success）
 *   - 「2つの意図的な操作 → durable には1件」という取りこぼしが、
 *     どちらの journal 読み取りが先に解決したかという **タイミング依存**で発生する
 * （`(owner_id, name)` の一意制約は DB に無く、同名同色の別 calendar 作成は
 *  正式に許される操作なので、fingerprint 一致は「同じ操作」の証明にならない）。
 *
 * そこで採用対象を「originating call が既に終了した pending」に限定する。
 * この Set は operation identity を決めた直後（＝journal へ書く前）に synchronous で
 * 印を付け、呼び出し終了時に必ず finally で外す。新しい永続状態は増やさない。
 */
const inFlightCreateOperationIds = new Set<string>();

/**
 * [P0134 QA-F021 / DATA-F021-001 ④] unknown outcome を **id で SELECT し直して**再判定する。
 *
 * 可視性の根拠（現行 migration のみから導出）:
 *   INSERT commit → `calendars` 行が存在
 *   → 同一トランザクションの AFTER INSERT トリガー `handle_new_calendar()`
 *      （`0001_init.sql:100-117`）が `calendar_members(role='owner')` を commit
 *   → RLS `calendars_select_members`（`0001_init.sql:149-151`）は
 *      `is_calendar_member(id,'viewer')` = `calendar_members.user_id = auth.uid()` を見る
 *   → 同一の認証済み owner から `id` 指定で SELECT すれば行は必ず見える。
 * ※ 実 DB 接続での確認は行っていない（`MIGRATION_APPLY = NO`）ため、
 *   この鎖の最終確証は `EXTERNAL_VALIDATION_PENDING`。
 *
 * 判定規則（[P0141 §5] 現行の 4 状態名に合わせて訂正。実装は元から下記のとおり）:
 *   SELECT 成功 + 一致する行 → `applied`（終局）
 *   SELECT 成功 + 0 rows      → `absent-now`（**非終局**。未コミットの元 INSERT が
 *                               後から commit し得るため、単独では破壊的 cleanup の
 *                               権限にならない。旧称 NOT_APPLIED は誤解を招くので廃止）
 *   SELECT 失敗 / 不明        → `unknown`（非終局。成功にも失敗にも縮退させない）
 *   SELECT 成功 + 行はあるが payload 不一致 → `conflict`（終局）
 * 一致条件は `id` / `owner_id` / `name` / `color` の4項目のみ。
 * `created_at` / `updated_at` は作成後に自動付与・変更され得るため
 * 含めない（含めると、正しく作成済みなのに偽の不一致になる）。
 */
export async function reconcileSharedCalendarCreate(
  pending: PendingSharedCalendarCreate,
  identity: SharedOperationIdentity
): Promise<SharedCalendarCreateReconcileOutcome> {
  // [P0136 ARCH/DATA-F021-003] session provenance を「見ていない」のではなく、
  // 明示的に分類したうえで recovery を許可する。
  // `foreign-owner` は SELECT すら送らない（journal も残す＝消さない）。
  const adoption = classifySharedCalendarCreateAdoption(pending, identity);
  if (adoption === "foreign-owner") {
    return { kind: "unknown", error: new Error("shared_calendar_create_owner_mismatch") };
  }
  let row: CalendarRow | null;
  try {
    row = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await supabase
        .from("calendars")
        .select("id, name, color, owner_id, created_at, updated_at")
        .eq("id", pending.calendarId)
        .maybeSingle();
      if (error) throw error;
      return (data as CalendarRow | null) ?? null;
    });
  } catch (e) {
    // ネットワーク断・RLS 以外の DB エラー・identity 切替。いずれも「適用有無は不明」。
    return { kind: "unknown", error: e };
  }
  if (row === null) {
    // [P0137 §3] 0 rows は **その SELECT スナップショットで見えなかった**ことしか証明しない。
    // 曖昧な書込みの後では、まだ未コミットの元 INSERT が後から commit し得る。
    // よってこれは **非終局（candidate）** であり、単独で破壊的な journal 削除を許可しない。
    return { kind: "absent-now" };
  }
  if (
    row.id !== pending.calendarId ||
    row.owner_id !== pending.ownerUserId ||
    row.name !== pending.name ||
    row.color !== pending.color
  ) {
    return { kind: "conflict", reason: "payload_mismatch", row: rowToCalendar(row) };
  }
  return { kind: "applied", calendar: rowToCalendar(row) };
}

/**
 * REVISE対応（第8ラウンド、P2）: identity（呼び出し元が固定したuserId/sessionInstanceId）を
 * 権威あるauthSessionIdentityStoreと照合してからSupabaseへリクエストを送る。
 * AppDataContext.tsx側で既に開始前チェックを行っていても、この関数自身が独立に検証する
 * ことで、将来の呼び出し元（未使用のcalendarFacade経由等）がこの検証を迂回できないように
 * する（呼び出し元が渡すidentityをそのまま信頼しない）。
 * REVISE対応（P0014 Batch1.1、P1-1）: remote呼出し自体を`awaitCurrentSharedOperation`へ通す
 * （fetchJoinedCalendarsと同じstale-priority契約。`runCurrentSharedMutation`自体の
 * reject時挙動は変更しない——禁止事項のため）。
 *
 * [P0134 QA-F021 / DATA-F021-001] 応答喪失（サーバは commit 済みだがクライアントには
 * 失敗に見える）後の正当なリトライが2件目を作らないよう、durable な operation identity
 * （= クライアントが決めた `calendars.id`）と、それを再起動後も思い出すための
 * `sharedCalendarCreateJournal` を導入した。UI の submit guard には依存しない。
 *
 * [P0137 §3/§4/§5] pending の採用境界と終局性を確定させた。
 *   `SHARED_CALENDAR_CREATE_ADOPTION_RULE = SAME_RUN_RESUME / CROSS_RUN_RECOVER_ONLY`
 * - 「同じ論理操作のリトライか」を決める境界は auth session ではなく
 *   **同一 JS ランタイム（アプリ起動）**である。`sessionInstanceId` は Supabase JWT の
 *   `session_id` claim であり、セッションが永続化されたまま再起動しても変わらないため、
 *   P0136 の `SAME_SESSION_RESUME` は「再起動後の意図的な新規作成」を
 *   同一 session と誤判定していた（P0137 §5）。
 * - `resume`（この run が始めた operation）だけが APPLIED の既存 calendar を返す。
 *   別 run の APPLIED は journal を畳むだけで、ユーザーの新しい要求は新規 create になる
 *   （false-success を作らない。`(owner_id, name)` の一意制約は DB に無く、
 *    同名同色の別 calendar 作成は正式に許される操作であるため）。
 * - **終局性**: 破壊的な journal 削除を許可するのは `applied` / `conflict` のみ。
 *   `absent-now`（0 rows）と `unknown` は非終局であり、単独では削除権限にならない（P0137 §3）。
 * - **23505 は outcome authority ではない**。必ず exact-id で再判定する（P0137 §4）。
 */
export async function createSharedCalendar(
  name: string,
  color: string,
  identity: SharedMutationIdentity
): Promise<SharedCalendar> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    // [P0139 §5] この呼び出しが握った operation identity。終了時に必ず解放する。
    const claimedOperationIds = new Set<string>();
    try {
      return await runCreateSharedCalendar(name, color, identity, assertCurrent, claimedOperationIds);
    } finally {
      for (const id of claimedOperationIds) inFlightCreateOperationIds.delete(id);
    }
  });
}

async function runCreateSharedCalendar(
  name: string,
  color: string,
  identity: SharedMutationIdentity,
  assertCurrent: () => void,
  claimedOperationIds: Set<string>
): Promise<SharedCalendar> {
    // ── ①未解決の前回attemptを先に決着させる（DATA-F021-001）─────────────
    // 応答喪失で終わった同一fingerprintのcreateが残っていれば、**新しい行を作る前に**
    // その結果をサーバへ問い合わせて確定させる。これをやらないと、
    // 「サーバはcommit済み・クライアントは失敗と認識」の後の正当なリトライが
    // 必ず2件目を作ってしまう（F021-IDEMP-1）。
    const pending = await readPendingSharedCalendarCreates(identity.userId);
    assertCurrent();

    // ── ①-a 別 run が残した pending は **終局結果のときだけ**畳む ──────────
    // [P0137 §3] 0 rows(absent-now) と unknown は非終局。単独で journal を消してはならない。
    //            消すと安定 operation identity が失われ、元 INSERT が後から commit したときに
    //            2件目が生まれる（P0137 が示した adversarial schedule そのもの）。
    for (const stale of pending) {
      const staleMode = resolveSharedCalendarCreateResumeMode(
        stale,
        identity,
        wasSharedCalendarCreateStartedInThisRun(stale.calendarId)
      );
      if (staleMode !== "recover-only") continue;
      if (resolvedCreateOperationIds.has(stale.calendarId)) continue;
      // [P0139 §5] 別の実行中呼び出しが既に採用した pending には触れない
      // （同じ operation を2つの呼び出しが同時に決着させにいかない）。
      if (inFlightCreateOperationIds.has(stale.calendarId)) continue;
      const recovered = await reconcileSharedCalendarCreate(stale, identity);
      assertCurrent();
      if (!isTerminalSharedCalendarCreateOutcome(recovered)) continue;
      resolvedCreateOperationIds.add(stale.calendarId);
      await clearPendingSharedCalendarCreate(stale.calendarId, identity.userId).catch(() => {});
      assertCurrent();
    }

    // ── ①-b 同一 fingerprint の未解決 pending を採用する ────────────────────
    // 採用モードは owner + **run provenance** で決まる（P0137 §5: auth session ではない）。
    // [P0141 §3 / DATA/ARCH-F021-010] 採用してよいのは **`resume`（この run が始めた
    // operation）だけ**。P0140 までは `!== "not-adoptable"` だったため `recover-only`
    // （別 run）も採用対象で、`applied` のときだけ `mode === "resume"` を確認していた。
    // その結果 `absent-now` / `unknown` では **別 run の calendarId が現在の要求の
    // operation identity として使われて**いた:
    //   Run1 の X が未コミットのまま Run2 でユーザーが意図的にもう1件作る
    //   → Run2 が X を再送 → その最中に T1 が commit → 再判定が APPLIED
    //   → Run2 は X を「自分の作成結果」として返す（＝2件目が存在しないのに成功）。
    // cross-run pending の面倒は ①-a の recovery sweep だけが見る。
    // 終局なら畳み、非終局なら保持する。どちらの場合も**新しい要求は新しい identity**で走る。
    const resumable = pending.find(
      (p) =>
        p.name === name &&
        p.color === color &&
        resolveSharedCalendarCreateResumeMode(
          p,
          identity,
          wasSharedCalendarCreateStartedInThisRun(p.calendarId)
        ) === "resume" &&
        !resolvedCreateOperationIds.has(p.calendarId) &&
        // [P0139 §5] **実行中の別呼び出しが握っている pending は採用しない**。
        // resume が正しいのは「originating call が既に終わっている」ときだけ。
        !inFlightCreateOperationIds.has(p.calendarId)
    );

    let reuseOperationId: string | null = null;
    if (resumable) {
      // find の直後・await を挟む前に synchronous で claim する
      // （claim 前に await を入れると、その隙に別呼び出しが同じ pending を採用できてしまう）。
      inFlightCreateOperationIds.add(resumable.calendarId);
      claimedOperationIds.add(resumable.calendarId);
      const outcome = await reconcileSharedCalendarCreate(resumable, identity);
      assertCurrent();
      switch (outcome.kind) {
        case "applied":
          // 終局。journal を畳む。
          resolvedCreateOperationIds.add(resumable.calendarId);
          await clearPendingSharedCalendarCreate(resumable.calendarId, identity.userId).catch(
            () => {}
          );
          assertCurrent();
          // ここに来られるのは `resume`（この run が始めた operation の継続）だけなので、
          // 既存 calendar を「その操作の結果」として返してよい。
          return outcome.calendar;
        case "conflict":
          // 終局。同じ id の行が存在するが payload が食い違う。retry しても直らない。
          resolvedCreateOperationIds.add(resumable.calendarId);
          await clearPendingSharedCalendarCreate(resumable.calendarId, identity.userId).catch(
            () => {}
          );
          assertCurrent();
          throw new SharedCalendarCreateConflictError("payload_mismatch");
        case "unknown":
          // 非終局。journal を残したまま元の remote エラーを投げる（新しい文言は増やさない）。
          throw outcome.error;
        case "absent-now":
          // 非終局。**消さずに、同じ calendarId のまま完遂しにいく**。
          // 元 INSERT が並行して commit していれば下の INSERT が 23505 を受け取り、
          // そこで exact-id reconcile がやり直される（どちらに転んでも calendar は1件）。
          reuseOperationId = resumable.calendarId;
          break;
      }
    }

    // ── ② operation identity を決めてから副作用を開始する ─────────────────
    // `absent-now` で降りてきた場合は **元の calendarId をそのまま使う**（新 UUID を振らない）。
    const calendarId = reuseOperationId ?? newCalendarOperationId();
    // [P0139 §5] journal へ書く**前**に claim する。これにより
    // 「pending が durable に存在する ⇒ claim 済み」が常に成り立ち、
    // 後発の呼び出しがその pending を採用してしまう窓が無くなる。
    inFlightCreateOperationIds.add(calendarId);
    claimedOperationIds.add(calendarId);
    if (reuseOperationId === null) {
      const entry: PendingSharedCalendarCreate = {
        calendarId,
        ownerUserId: identity.userId,
        ownerSessionInstanceId: identity.sessionInstanceId,
        name,
        color,
        createdAt: new Date().toISOString(),
      };
      // INSERT を送る**前**に必ず永続化する。ここが失敗したらリクエスト自体を送らない
      // （送ってしまうと、再判定手段の無い unknown outcome を再び作ることになる）。
      await putPendingSharedCalendarCreate(entry);
      assertCurrent();
    }

    const pendingForReconcile: PendingSharedCalendarCreate = {
      calendarId,
      ownerUserId: identity.userId,
      ownerSessionInstanceId: identity.sessionInstanceId,
      name,
      color,
      createdAt: new Date().toISOString(),
    };

    let data: unknown;
    try {
      data = await awaitCurrentSharedOperation(identity, async () => {
        // P0154 (SEC-AUTH-TRANSPORT-001): F021 の create INSERT も pinned transport で送る。
        // 捕捉は「pending journal を durable に永続化したあと・実際の送出の直前」で行う
        // （正本 §2-B の順序）。捕捉に失敗すれば送出自体が起きず、journal は
        // UNKNOWN のまま残る＝既存の非終端契約（SAME_RUN_RESUME / CROSS_RUN_RECOVER_ONLY）
        // をそのまま維持する。journal を消して認可処理を単純化することはしない。
        const { data: inserted, error } = await withPinnedSharedClient(identity, (client) =>
          client
            .from("calendars")
            .insert({ id: calendarId, name, color, owner_id: identity.userId })
            .select("id, name, color, owner_id, created_at, updated_at")
            .single()
        );
        if (error) throw error;
        return inserted;
      });
    } catch (e) {
      // [P0137 §4 / DATA-F021-005] 23505 は「その id の行が存在する」**ヒント**に過ぎず、
      // outcome authority ではない。PostgreSQL の一意制約チェックは未コミットの競合
      // トランザクションを待つため、元 INSERT が後から commit した結果として
      // 23505 が返ることがある（＝実際には APPLIED）。
      //
      // [P0139 §3 / DATA-F021-006] **エラー種別による分岐そのものを廃止する**。
      // P0138 は 23505 のときだけ再判定していたが、0016 の
      // `enforce_owned_shared_calendar_limit()` は BEFORE INSERT トリガーであり、
      //   owner advisory lock → 件数再計算 → limit error
      // の順で **PK 一意性チェックより先に** 発火する。したがって
      //   retry の SELECT が 0 rows → 元 INSERT が commit → retry が lock 待ち
      //   → 件数が上限到達 → owned_shared_calendar_limit_exceeded（非 23505）
      // という並びが成立し、実際には APPLIED なのに「作成失敗」と報告してしまう。
      // 安定した operation identity を journal 済みで送った後は、
      // **どのエラーでも** exact-id の再判定だけを outcome authority とする。
      const after = await reconcileSharedCalendarCreate(pendingForReconcile, identity);
      assertCurrent();
      if (after.kind === "applied") {
        resolvedCreateOperationIds.add(calendarId);
        await clearPendingSharedCalendarCreate(calendarId, identity.userId).catch(() => {});
        assertCurrent();
        return after.calendar;
      }
      if (after.kind === "conflict") {
        resolvedCreateOperationIds.add(calendarId);
        await clearPendingSharedCalendarCreate(calendarId, identity.userId).catch(() => {});
        assertCurrent();
        throw new SharedCalendarCreateConflictError("payload_mismatch");
      }
      // absent-now / unknown はいずれも非終局。**journal を消さず**元エラーを投げる。
      throw e;
    }
    assertCurrent();
    // 権威ある結果を受け取れている＝APPLIED 確定（終局）。
    // 削除に失敗しても、確定済みの主操作を失敗として報告しない（ADR-0120 / P0123）。
    resolvedCreateOperationIds.add(calendarId);
    await clearPendingSharedCalendarCreate(calendarId, identity.userId).catch(() => {});
    assertCurrent();
    return rowToCalendar(data as CalendarRow);
}

/**
 * [P0162 QA-F022 CORRECT-F022-001] 「エラーが無いこと」は書き込みが適用された証明ではない。
 *
 * `calendars_update_owner`（0001_init.sql / 0020_account_deletion.sql）は
 *
 * ```sql
 * using (public.is_calendar_member(id, 'owner'))
 * ```
 *
 * という **USING 句で対象行を絞り込む**ポリシーである。owner でない・メンバーでない・
 * そもそも行が存在しない場合、UPDATE は PostgreSQL/RLS 的には「0件が条件に一致した」
 * という扱いになり、**エラーを一切返さない**（サイレント no-op）。
 * `.select()` を付けずに `.update(...).eq(...)` を await すると supabase-js は
 * `{ data: null, error: null }` を返すため、呼び出し側には「適用された」と
 * 「1行も変わっていない」を区別する情報が届かない。
 *
 * これは P0080 F015 が events（`events_delete_editor`）で塞いだ phantom deletion と
 * **同一の根本原因**である。到達経路も役割変更を必要としない:
 *   端末Aで設定画面を開いたまま端末B（同一オーナー）でそのカレンダーを削除
 *   → 端末Aの改名は 0 行更新・エラー無し → アプリが「成功」として扱う（phantom rename）。
 *
 * 対処: 実際に更新された行を `.select("id")` で受け取り、0 件のときだけ
 * `calendars_select_members`（viewer 以上で可視）で存在を再確認する。
 *   - まだ存在する → 更新がブロックされたことが**確定**（BLOCKED）
 *   - 見えない     → 削除済みか読取権喪失かを**区別できない**ため、成功と断定せず
 *                    UNCONFIRMED として扱う（over-claim しない）
 *
 * 文言はいずれも既存の `toFriendlyMessage` で安全に解決される
 * （BLOCKED は "permission" を含むため `friendlyError.notAuthorized`、
 *  UNCONFIRMED は該当分岐が無いため呼び出し側の fallback にそのまま落ちる）。
 * 新しい i18n キーは追加していない。
 */
export const SHARED_CALENDAR_UPDATE_BLOCKED_MESSAGE = "shared_calendar_update_permission_denied";
export const SHARED_CALENDAR_UPDATE_UNCONFIRMED_MESSAGE = "shared_calendar_update_result_unconfirmed";

/**
 * カレンダーの名前・色を更新する。RLSの`calendars_update_owner`ポリシーにより、
 * 実際に更新できるのはownerのみ（DBスキーマ・RLSの変更は不要、既存ポリシーをそのまま使う）。
 * REVISE対応（第8ラウンド、P2）: createSharedCalendarと同じ理由でidentityを検証する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 * [P0162 CORRECT-F022-001] 0行更新を成功として返さない（上のdoc参照）。
 */
export async function updateCalendar(
  calendarId: string,
  updates: { name?: string; color?: string },
  identity: SharedMutationIdentity
): Promise<void> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    // P0154 正本 §3: 複数の送出を含む1つの論理操作では、捕捉は1回だけ行い
    // pinned クライアントを操作全体で共有する（送出ごとに捕捉し直さない）。
    const auth = await captureSharedMutationAuthSnapshot(identity);
    const client = createPinnedSharedClient(auth);
    const applied = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await client
        .from("calendars")
        .update(updates)
        .eq("id", calendarId)
        .select("id");
      if (error) throw error;
      return (data ?? []) as { id: string }[];
    });
    assertCurrent();
    if (applied.length > 0) return;
    const stillExists = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await client
        .from("calendars")
        .select("id")
        .eq("id", calendarId)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string } | null;
    });
    assertCurrent();
    throw new Error(
      stillExists
        ? SHARED_CALENDAR_UPDATE_BLOCKED_MESSAGE
        : SHARED_CALENDAR_UPDATE_UNCONFIRMED_MESSAGE
    );
  });
}


/**
 * [P0162 QA-F022 CORRECT-F022-001 兄弟] `calendars_delete_owner` も USING 句のみの
 * ポリシーであり、`updateCalendar` と**同一の根本原因**を持つ（0件削除・エラー無し）。
 * 同じ設定画面（`app/calendar/[id]/settings.tsx`）から呼ばれる同じテーブルの操作なので、
 * 同一バッチ・同一根本原因の修正としてここも塞ぐ。
 *
 * ただし削除の判定は update と異なる。**「その行が無い」ことが望む終端状態**なので、
 * 0件削除でも行が既に見えない場合は従来どおり成功（冪等）として扱う
 * （P0080 F015 の `deleteSharedEvent` と同じ判断）。
 */
export const SHARED_CALENDAR_DELETE_BLOCKED_MESSAGE = "shared_calendar_delete_permission_denied";
/**
 * [P0164 CORRECT-F023-001] 0 件削除かつ後続 SELECT でも見えない場合の outcome。
 * 「削除済み」と「読取権喪失」を区別できないため、成功とも拒否とも断定しない。
 */
export const SHARED_CALENDAR_DELETE_UNCONFIRMED_MESSAGE = "shared_calendar_delete_result_unconfirmed";

/**
 * カレンダーを削除する。RLSの`calendars_delete_owner`ポリシーにより、
 * 実際に削除できるのはownerのみ（既存ポリシーをそのまま使う）。
 * `calendar_members`/`events`/`calendar_invites`はDB側のON DELETE CASCADEで連動して削除される。
 * REVISE対応（第8ラウンド、P2）: createSharedCalendarと同じ理由でidentityを検証する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 * [P0162 CORRECT-F022-001 兄弟] 0件削除＋行が残存している場合は成功として返さない。
 */
export async function deleteCalendar(
  calendarId: string,
  identity: SharedMutationIdentity
): Promise<void> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    // P0154 正本 §3: 複数送出を含む論理操作なので捕捉は1回だけ行う。
    const auth = await captureSharedMutationAuthSnapshot(identity);
    const client = createPinnedSharedClient(auth);
    const deleted = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await client
        .from("calendars")
        .delete()
        .eq("id", calendarId)
        .select("id");
      if (error) throw error;
      return (data ?? []) as { id: string }[];
    });
    assertCurrent();
    if (deleted.length > 0) return;
    const stillExists = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await client
        .from("calendars")
        .select("id")
        .eq("id", calendarId)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string } | null;
    });
    assertCurrent();
    if (stillExists) throw new Error(SHARED_CALENDAR_DELETE_BLOCKED_MESSAGE);
    // [P0164 D / CORRECT-F023-001] **ここは以前 success として返していた（P0162）。**
    // しかしその読み取りは `calendars_select_members`（viewer 以上で可視）越しであり、
    //   - 本当に行が消えた
    //   - 自分がメンバーでなくなり読めなくなっただけ
    // を区別できない。**RLS 不可視はグローバルな不在の証明ではない。**
    // 権威ある終端不在を確立できないため、冪等成功と断定せず UNCONFIRMED を返す。
    throw new Error(SHARED_CALENDAR_DELETE_UNCONFIRMED_MESSAGE);
  });
}

/**
 * REVISE対応（第10ラウンド、P1-2）: この関数はapp/calendar/[id]/members.tsx・
 * app/calendar/[id]/settings.tsxから画面のローカルstateへ直接setStateされるため、
 * SharedMutationIdentityを要求し、remote呼出し前・remote完了後（結果を返す前）の
 * 両方でidentityを確認する。identityが変わっていた場合は結果を返さず例外を投げる
 * （呼び出し元のtry/catchが、古いidentity向けの応答をstateへ反映しない設計の前提）。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function fetchCalendarMembers(
  calendarId: string,
  identity: SharedMutationIdentity
): Promise<CalendarMembership[]> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await supabase
        .from("calendar_members")
        .select("calendar_id, user_id, role, profiles(display_name)")
        .eq("calendar_id", calendarId);
      if (error) throw error;
      return data;
    });
    assertCurrent();
    return (data as unknown as MemberRow[]).map((row) => ({
      calendarId: row.calendar_id,
      userId: row.user_id,
      role: row.role,
      displayName: row.profiles?.display_name ?? undefined,
    }));
  });
}

/**
 * REVISE対応（第9ラウンド、P1-2）: SharedMutationIdentityを要求し、remote呼出し前・
 * remote完了後（成功結果を返す前）の両方でidentityを確認する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function updateMemberRole(
  calendarId: string,
  userId: string,
  role: CalendarRole,
  identity: SharedMutationIdentity
): Promise<void> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    // P0154 正本 §3: 複数送出を含む論理操作なので捕捉は 1 回だけ。
    const auth = await captureSharedMutationAuthSnapshot(identity);
    const client = createPinnedSharedClient(auth);
    const applied = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await client
        .from("calendar_members")
        .update({ role })
        .eq("calendar_id", calendarId)
        .eq("user_id", userId)
        .select("user_id");
      if (error) throw error;
      return (data ?? []) as { user_id: string }[];
    });
    assertCurrent();
    if (applied.length > 0) return;
    const outcome = await classifyZeroRowMemberEffect(client, calendarId, userId, identity);
    assertCurrent();
    // role 変更は「対象がまだ居る」ことが前提の操作なので、already-absent も
    // 適用され得ない確定的失敗として blocked と同じ扱いにする（成功にはしない）。
    throw new Error(
      outcome === "unconfirmed"
        ? SHARED_MEMBER_WRITE_UNCONFIRMED_MESSAGE
        : SHARED_MEMBER_WRITE_BLOCKED_MESSAGE
    );
  });
}

/**
 * [P0164 §4] 0 行だったときに、呼び出し元が**対象集合そのものを観測できるか**を基準に
 * outcome を決める。`members_select_same_calendar` は viewer 以上に見えるので、
 * 一覧が 1 件でも読めていれば「その一覧に対象が居ない」＝権威ある不在と言える。
 * 一覧が空の場合は「本当に誰も居ない」と「自分が読めなくなった」を区別できないため
 * 必ず `unconfirmed` になる（RLS 不可視をグローバル不在と読み替えない）。
 */
async function classifyZeroRowMemberEffect(
  client: ReturnType<typeof createPinnedSharedClient>,
  calendarId: string,
  userId: string,
  identity: SharedMutationIdentity
): Promise<Exclude<WriteEffectOutcome, "applied">> {
  const rows = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await client
      .from("calendar_members")
      .select("user_id")
      .eq("calendar_id", calendarId);
    if (error) throw error;
    return (data ?? []) as { user_id: string }[];
  });
  return classifyZeroRowEffect({
    canObserveTargetSet: rows.length > 0,
    targetStillPresent: rows.some((r) => r.user_id === userId),
  });
}

/**
 * [P0164 §3 / CORRECT-F029-001] 自己退出は専用のサーバ権威（RPC）で行う。
 *
 * **なぜテーブル直 DELETE ではだめか**: `calendar_members` の削除ポリシーは
 * `members_delete_owner`（owner 限定）しか存在しない。一方で設定画面は
 * **非 owner に「退出」を出している**。したがって editor/viewer の退出は
 * サーバ側で必ず 0 行になり、それでもエラーは返らない——つまり
 * 「退出したように見えて実際には残っている」phantom leave が必ず起きる。
 *
 * RPC は明示的な outcome を返すため RLS 不可視の曖昧さが原理的に発生しない
 * （SERVER_EXPLICIT_OUTCOME）。owner の自己退出はカレンダーを孤児にするため
 * サーバ側で拒否する。
 *
 * `MIGRATION_APPLY = NO`: 対応する migration 0023 は本バッチでは**適用していない**。
 */
export async function leaveSharedCalendar(
  calendarId: string,
  identity: SharedMutationIdentity
): Promise<"left" | "not_member"> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await withPinnedSharedClient(identity, (client) =>
        client.rpc("leave_shared_calendar", { p_calendar_id: calendarId })
      );
      if (error) throw error;
      return data;
    });
    assertCurrent();
    const row = firstRow<{ outcome: string }>(data);
    if (!row) throw new Error(SHARED_CALENDAR_LEAVE_UNCONFIRMED_MESSAGE);
    if (row.outcome === "left") return "left";
    // 既にメンバーでない＝望む終端状態が**サーバ権威により**達成済み（冪等成功）。
    if (row.outcome === "not_member") return "not_member";
    if (row.outcome === "owner_cannot_leave") {
      throw new Error(SHARED_CALENDAR_LEAVE_BLOCKED_MESSAGE);
    }
    throw new Error(SHARED_CALENDAR_LEAVE_UNCONFIRMED_MESSAGE);
  });
}

/**
 * REVISE対応（第9ラウンド、P1-2）: updateMemberRoleと同じ理由でidentityを検証する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function removeMember(
  calendarId: string,
  userId: string,
  identity: SharedMutationIdentity
): Promise<void> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const auth = await captureSharedMutationAuthSnapshot(identity);
    const client = createPinnedSharedClient(auth);
    const applied = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await client
        .from("calendar_members")
        .delete()
        .eq("calendar_id", calendarId)
        .eq("user_id", userId)
        .select("user_id");
      if (error) throw error;
      return (data ?? []) as { user_id: string }[];
    });
    assertCurrent();
    if (applied.length > 0) return;
    const outcome = await classifyZeroRowMemberEffect(client, calendarId, userId, identity);
    assertCurrent();
    // 削除は「その行が無い」ことが望む終端状態。ただし **不在を権威をもって確認できた場合のみ**
    // 冪等成功にできる（呼び出し元がメンバー一覧そのものを読めていること）。
    if (outcome === "already-absent") return;
    throw new Error(
      outcome === "unconfirmed"
        ? SHARED_MEMBER_WRITE_UNCONFIRMED_MESSAGE
        : SHARED_MEMBER_WRITE_BLOCKED_MESSAGE
    );
  });
}

/**
 * REVISE対応（第10ラウンド、P1-2）: app/calendar/[id]/invite.tsx・
 * app/calendar/[id]/settings.tsxから画面のローカルstateへ直接setStateされるため、
 * fetchCalendarMembersと同じ理由でSharedMutationIdentityを要求する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function fetchInvites(
  calendarId: string,
  identity: SharedMutationIdentity
): Promise<CalendarInvite[]> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await supabase
        .from("calendar_invites")
        // P0178 / CORRECT-F024-003: invitee_email を必ず取得する。
        // これが無いと呼び出し側は TARGETED と GENERIC を区別できない。
        .select(
          "id, calendar_id, role, created_by, created_at, expires_at, revoked_at, accepted_at, declined_at, invitee_email"
        )
        .eq("calendar_id", calendarId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    });
    assertCurrent();
    return (data ?? []).map((row) => ({
      id: row.id,
      calendarId: row.calendar_id,
      role: row.role,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
      acceptedAt: row.accepted_at ?? undefined,
      declinedAt: row.declined_at ?? undefined,
      inviteeEmail: row.invitee_email ?? undefined,
    }));
  });
}

/**
 * 招待作成。生トークンはこのレスポンスにのみ含まれ、以後は取得できない。
 * REVISE対応（第9ラウンド、P1-2）: SharedMutationIdentityを要求する（optionsが省略可能な
 * ため、TypeScript上必須引数であるidentityはoptionsより前に置く）。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function createInvite(
  calendarId: string,
  role: Extract<CalendarRole, "editor" | "viewer">,
  identity: SharedMutationIdentity,
  options?: { expiresInHours?: number; inviteeEmail?: string }
): Promise<{ invite: CalendarInvite; token: string }> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await withPinnedSharedClient(identity, (client) =>
        client.rpc("create_calendar_invite", {
          p_calendar_id: calendarId,
          p_role: role,
          p_expires_in_hours: options?.expiresInHours ?? 168,
          p_invitee_email: options?.inviteeEmail ?? null,
        })
      );
      if (error) throw error;
      return data;
    });
    assertCurrent();
    const row = Array.isArray(data) ? data[0] : data;
    return {
      invite: {
        id: row.invite_id,
        calendarId,
        role,
        createdBy: "",
        createdAt: new Date().toISOString(),
        expiresAt: row.expires_at,
        /**
         * P0180 / CORRECT-F024-003-D: **要求した発行スコープをそのまま返す。**
         *
         * 呼び出し側は返ってきた invite から `classifyInviteScope()` で
         * キャッシュ資格のスコープを決める。ここが undefined のままだと、
         * targeted を要求して作った招待まで generic と分類され、
         * その後の現行性照合が別スコープを見に行ってしまう。
         *
         * **server の意味論は変えていない。** RPC 側の
         * `nullif(lower(trim(p_invitee_email)), '')` と同一の正規化を
         * client 側で再現し、要求値をそのまま写しているだけである
         * （`normalizeInviteRecipient` が同じ規則を実装している）。
         */
        inviteeEmail: normalizeInviteRecipient(options?.inviteeEmail) ?? undefined,
      },
      token: row.token,
    };
  });
}

/**
 * REVISE対応（第9ラウンド、P1-2）: createInviteと同じ理由でidentityを検証する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function revokeInvite(
  inviteId: string,
  identity: SharedMutationIdentity
): Promise<void> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    await awaitCurrentSharedOperation(identity, async () => {
      const { error } = await withPinnedSharedClient(identity, (client) =>
        client.rpc("revoke_calendar_invite", {
          p_invite_id: inviteId,
        })
      );
      if (error) throw error;
    });
    assertCurrent();
  });
}

export interface AcceptInviteResult {
  calendarId: string;
  calendarName: string;
  role: CalendarRole;
}

/**
 * 招待参加。同じ招待で複数回呼んでもメンバーが重複しない（サーバー側でON CONFLICT DO NOTHING）。
 * REVISE対応（第9ラウンド、P1-2）: SharedMutationIdentityを要求する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function acceptInvite(
  token: string,
  identity: SharedMutationIdentity
): Promise<AcceptInviteResult> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      // P0154 (SEC-AUTH-TRANSPORT-001): サーバー側 SQL は **リクエストJWTの auth.uid()** を
      // calendar_members へ INSERT する。ambient のままだと「Aが押した受諾で B がメンバーになる」
      // ことが起こりうるため、この経路は特に P1 センシティブ。
      const { data, error } = await withPinnedSharedClient(identity, (client) =>
        client.rpc("accept_calendar_invite", {
          p_token: token,
        })
      );
      if (error) throw error;
      return data;
    });
    assertCurrent();
    const row = Array.isArray(data) ? data[0] : data;
    return {
      calendarId: row.calendar_id,
      calendarName: row.calendar_name,
      role: row.role,
    };
  });
}

interface PendingInviteRow {
  invite_id: string;
  calendar_id: string;
  calendar_name: string;
  calendar_color: string;
  role: Extract<CalendarRole, "editor" | "viewer">;
  created_at: string;
  expires_at: string;
  inviter_display_name: string | null;
}

/**
 * ログイン中ユーザー宛てに届いている未処理招待の一覧。「未処理」の判定は
 * fetch_my_pending_invites RPC側のWHERE句が正本（この関数側では絞り込みを行わない）。
 * REVISE対応（第11ラウンド、P1-1）: identityを必須にし、remote呼出し前後で検証する
 * （RPC自体はauth.jwt()に基づきサーバー側で本人の招待だけを返すが、クライアント側の
 * identity契約を他の共有読取り関数と揃えるため）。
 * REVISE対応（P0014 Batch1.1、P1-1）: fetchJoinedCalendarsと同じstale-priority契約。
 */
export async function fetchPendingInvitesForCurrentUser(
  identity: SharedOperationIdentity
): Promise<PendingInvite[]> {
  const data = await awaitCurrentSharedOperation(identity, async () => {
    const { data, error } = await supabase.rpc("fetch_my_pending_invites");
    if (error) throw error;
    return data;
  });
  return ((data ?? []) as PendingInviteRow[]).map((row) => ({
    id: row.invite_id,
    calendarId: row.calendar_id,
    calendarName: row.calendar_name,
    calendarColor: row.calendar_color,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    inviterDisplayName: row.inviter_display_name ?? undefined,
  }));
}

/**
 * 招待一覧（生トークンを持たないカード）からの参加。認可はサーバー側でauth.jwt()->>'email'と
 * invitee_emailの一致により行われる——クライアントは招待IDを渡すだけでよい。
 * REVISE対応（第8ラウンド、P2）: createSharedCalendarと同じ理由でidentityを検証する
 * （このカードから呼ぶAppDataContext.acceptPendingInviteは共有mutationの1つのため）。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function acceptPendingInviteById(
  inviteId: string,
  identity: SharedMutationIdentity
): Promise<AcceptInviteResult> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await withPinnedSharedClient(identity, (client) =>
        client.rpc("accept_calendar_invite_by_id", {
          p_invite_id: inviteId,
        })
      );
      if (error) throw error;
      return data;
    });
    assertCurrent();
    const row = Array.isArray(data) ? data[0] : data;
    return {
      calendarId: row.calendar_id,
      calendarName: row.calendar_name,
      role: row.role,
    };
  });
}

/**
 * 招待の拒否。calendar_membersには一切触れない（参加しない）。
 * REVISE対応（第8ラウンド、P2）: acceptPendingInviteByIdと同じ理由でidentityを検証する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function declinePendingInvite(
  inviteId: string,
  identity: SharedMutationIdentity
): Promise<void> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    await awaitCurrentSharedOperation(identity, async () => {
      const { error } = await withPinnedSharedClient(identity, (client) =>
        client.rpc("decline_calendar_invite", {
          p_invite_id: inviteId,
        })
      );
      if (error) throw error;
    });
    assertCurrent();
  });
}

interface MemberLimitStatusRow {
  member_limit: number;
  current_member_count: number;
  active_invite_count: number;
  used_slot_count: number;
  remaining_slots: number;
  limit_reached: boolean;
}

/**
 * FP-008(2026-08): 共有カレンダー1件あたりのメンバー数上限の現在状態を取得する。
 * サーバー側（get_shared_calendar_member_limit_status RPC）が唯一の正本であり、
 * ここでは返却値をそのままcamelCaseへ変換するだけで、クライアント側で独自に
 * 上限値や残り枠を計算し直さない（呼び出し本人のローカル状態からは一切決定しない）。
 */
/**
 * REVISE対応（第10ラウンド、P1-2）: app/calendar/[id]/invite.tsx・
 * app/calendar/[id]/settings.tsxから画面のローカルstateへ直接setStateされるため、
 * fetchCalendarMembersと同じ理由でSharedMutationIdentityを要求する。
 * REVISE対応（P0014 Batch1.1、P1-1）: createSharedCalendarと同じstale-priority契約。
 */
export async function fetchSharedCalendarMemberLimitStatus(
  calendarId: string,
  identity: SharedMutationIdentity
): Promise<SharedCalendarMemberLimitStatus> {
  return runCurrentSharedMutation(identity, async (assertCurrent) => {
    const data = await awaitCurrentSharedOperation(identity, async () => {
      const { data, error } = await supabase.rpc("get_shared_calendar_member_limit_status", {
        p_calendar_id: calendarId,
      });
      if (error) throw error;
      return data;
    });
    assertCurrent();
    const row = (Array.isArray(data) ? data[0] : data) as MemberLimitStatusRow;
    return {
      memberLimit: row.member_limit,
      currentMemberCount: row.current_member_count,
      activeInviteCount: row.active_invite_count,
      usedSlotCount: row.used_slot_count,
      remainingSlots: row.remaining_slots,
      limitReached: row.limit_reached,
    };
  });
}
