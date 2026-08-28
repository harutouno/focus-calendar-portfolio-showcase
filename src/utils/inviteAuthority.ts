import { CalendarInvite, CalendarRole } from "@/types/sharing";

/**
 * P0178 / CORRECT-F024-003 — 招待権威の 4 概念を明示的に分離する純関数群。
 *
 * 現行コードと過去の監査は次の 4 つを**1 つの `active invite` 真偽値へ潰していた**。
 * それが `INVITE_AUTHORITY_SCOPE_AND_REDEEMABILITY_MODEL_MISMATCH` の根である。
 *
 * ```text
 * PENDING_FOR_SLOT_COUNT            人数枠を消費するか        → countsTowardMemberSlot()
 * REDEEMABLE_TOKEN_AUTHORITY        token がまだ使えるか      → isInviteRedeemable()
 * INVITE_ISSUANCE_SCOPE             どの発行スコープに属すか  → classifyInviteScope()
 * CLIENT_VISIBLE_CURRENT_CREDENTIAL 画面が現在の資格として扱う → findActiveGenericViewerInvite()
 * ```
 *
 * **この 4 つは意図的に一致しない。** 特に:
 *
 * ```text
 * accepted_at != NULL かつ revoked_at == NULL かつ未期限切れ の generic token は
 *   countsTowardMemberSlot = false   （人数枠は消費しない）
 *   isInviteRedeemable    = true     （まだ誰でも参加できる）
 * ```
 *
 * したがって「人数枠として数えない＝もう無効」と読み替えてはならない。
 * 0026 はまさにその読み替えをしており、supersede 述語に count 述語をコピーしていた。
 */

/** 招待の発行スコープ。migration 0026/0027 の TARGETED / GENERIC と 1 対 1 に対応する。 */
export type InviteScope =
  | { readonly kind: "targeted"; readonly calendarId: string; readonly normalizedRecipient: string }
  | { readonly kind: "generic"; readonly calendarId: string; readonly role: CalendarRole };

/**
 * 宛先メールの正規化。**SQL 側 `nullif(lower(trim(p_invitee_email)), '')` と同一規則**。
 * 突き合わせ規則が client と server でずれると、同じ行を別スコープと判定してしまう。
 */
export function normalizeInviteRecipient(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** 発行スコープの判定。宛先の有無だけで決まり、accepted/declined/revoked とは無関係。 */
export function classifyInviteScope(invite: CalendarInvite): InviteScope {
  const recipient = normalizeInviteRecipient(invite.inviteeEmail);
  return recipient === null
    ? { kind: "generic", calendarId: invite.calendarId, role: invite.role }
    : { kind: "targeted", calendarId: invite.calendarId, normalizedRecipient: recipient };
}

/** 2 つのスコープが同一の発行権威を指すか（0027 の supersede 選択と同じ規則）。 */
export function isSameInviteScope(a: InviteScope, b: InviteScope): boolean {
  if (a.calendarId !== b.calendarId) return false;
  if (a.kind === "targeted" && b.kind === "targeted") {
    // TARGETED は role-independent。同一宛先なら role が違っても同一権威。
    return a.normalizedRecipient === b.normalizedRecipient;
  }
  if (a.kind === "generic" && b.kind === "generic") {
    // GENERIC は role-specific。generic editor と generic viewer は別権威。
    return a.role === b.role;
  }
  return false;
}

/**
 * **REDEEMABLE_TOKEN_AUTHORITY** — その token がまだ引き換え可能か。
 *
 * 権威は **migration 0020 G2 の `accept_calendar_invite(p_token)`**。これが
 * 最後の置換であり、現行契約である。
 * そこが実際に拒否するのは次の 3 つだけである:
 *
 * ```text
 * 行が無い / revoked_at is not null / expires_at < now()
 * ```
 *
 * `accepted_at` は **拒否条件ではない**（`update ... where accepted_at is null` で
 * 初回受諾時刻を記録するだけ）。`declined_at` も token 経路では見ていない
 * （by_id 経路のみが declined を拒否する）。
 * したがって multi-user generic link は受諾後も引き換え可能であり続ける。
 */
export function isInviteRedeemable(invite: CalendarInvite, nowMs: number): boolean {
  if (invite.revokedAt) return false;
  const expiresAtMs = Date.parse(invite.expiresAt);
  // 期限が解釈不能なら fail-closed（引き換え可能と見なさない）。
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs > nowMs;
}

/**
 * **PENDING_FOR_SLOT_COUNT** — 人数枠を消費する pending invite か。
 *
 * 権威は migration 0018 の `count_effective_shared_calendar_members`:
 * `revoked_at is null and declined_at is null and accepted_at is null and expires_at > now()`。
 *
 * `isInviteRedeemable` より**厳しい**。受諾済み generic token は枠を消費しないが
 * 引き換えは可能、という非対称がここに現れる。
 */
export function countsTowardMemberSlot(invite: CalendarInvite, nowMs: number): boolean {
  if (invite.revokedAt) return false;
  if (invite.declinedAt) return false;
  if (invite.acceptedAt) return false;
  const expiresAtMs = Date.parse(invite.expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs > nowMs;
}

/**
 * **CLIENT_VISIBLE_CURRENT_CREDENTIAL** — 設定画面が「現在の generic viewer リンク」として
 * 扱うべき唯一の招待。
 *
 * 条件:
 *   role = viewer / スコープ = generic（宛先なし）/ 現行の redeemability 判定で有効
 *
 * **targeted な viewer 招待は決してここに含まれない。** 含めてしまうと、
 * generic リンクを得るためだけに他人宛の招待を失効させる巻き添えが起きる。
 * また `acceptedAt` があるだけでは除外しない——token 経路が受諾後も他ユーザーを
 * 受け入れる以上、その generic リンクは依然として「現在の資格」だからである。
 */
export function findActiveGenericViewerInvite(
  invites: readonly CalendarInvite[],
  nowMs: number
): CalendarInvite | undefined {
  return invites.find(
    (invite) =>
      invite.role === "viewer" &&
      classifyInviteScope(invite).kind === "generic" &&
      isInviteRedeemable(invite, nowMs)
  );
}

// ════════════════════════════════════════════════════════════════════════
// P0180 / CORRECT-F024-003-D — キャッシュした生資格の権威束縛
// ════════════════════════════════════════════════════════════════════════

/**
 * client が手元に持っている**生の招待資格**。
 *
 * 【なぜ token だけでは足りないか】
 * P0178 まで、client は生資格を token（あるいは token を埋め込んだ URL）だけで
 * 保持していた。`createInvite()` は `{ invite: { id, ... }, token }` を返しているのに
 * **invite id を捨てていた**。その結果:
 *
 * ```text
 * SERVER_CURRENT_INVITE_AUTHORITY が変わっても
 * CLIENT_RAW_TOKEN_CACHE は変わらない
 * ```
 *
 * identity ゲートも同一プロセスの single-flight も、この乖離は検出できない。
 * どちらも「誰が・いつ」を守る仕組みであって、「この手元の資格がまだ現行権威か」
 * という問いには答えないからである。**id が無ければ問い自体を立てられない。**
 *
 * 【設計上の制約】
 * - **永続化しない。** 生 token をディスクへ書かない（in-memory のみ）。
 * - **ログ・証跡へ出さない。**
 * - `scope` を一緒に持つ。id だけでは「同じ id が別スコープの権威になった」
 *   ケースを弾けないうえ、再発行時に何を作り直すべきかも決められない。
 */
export type CachedInviteCredential = {
  readonly inviteId: string;
  readonly token: string;
  readonly scope: InviteScope;
};

/** キャッシュ資格の現行性判定の結果。stale は理由まで返す（呼び出し側の分岐が変わるため）。 */
export type CachedCredentialCurrency =
  | { readonly status: "current"; readonly invite: CalendarInvite }
  | {
      readonly status: "stale";
      readonly reason:
        | "not-found"
        | "not-redeemable"
        | "scope-mismatch"
        | "not-current-generic-viewer-authority";
    };

/**
 * **キャッシュ資格が権威スナップショットに照らして現行か**を証明する純関数。
 *
 * これが P0180 の中心的な述語であり、将来の Immune 定義
 * （`CLIENT_EXTERNALIZED_INVITE_CREDENTIAL_CURRENT`）のフック点でもある。
 * ここで証明できるのは次の 3 つ（generic viewer は 4 つ目も）である:
 *
 * ```text
 * 1. その inviteId の行がスナップショットに存在する
 * 2. その行が現行の F024 権威（0020 G2）で redeemable である
 * 3. その行のスコープがキャッシュ時のスコープと一致する
 * 4. generic viewer の場合、受理済み権威モデルが選ぶ「現在の generic viewer 行」と同一である
 * ```
 *
 * **`invites` は権威的に取得できたスナップショットでなければならない。**
 * 取得に失敗した（UNKNOWN）場合にこの関数へ空配列を渡してはいけない——
 * それは「読めなかった」を「存在しない」と偽ることになる。
 * UNKNOWN は呼び出し側で fail-closed に扱い、この関数を呼ばないこと。
 *
 * **観測後に server 側で revoke / 再発行が起きる可能性は排除しない。**
 * それは通常の分散失効の意味論であり、本関数はその不可能性を主張しない。
 */
export function isCachedCredentialCurrentAgainstInviteSnapshot(
  credential: CachedInviteCredential,
  invites: readonly CalendarInvite[],
  nowMs: number
): CachedCredentialCurrency {
  const match = invites.find((invite) => invite.id === credential.inviteId);
  if (!match) return { status: "stale", reason: "not-found" };
  if (!isInviteRedeemable(match, nowMs)) return { status: "stale", reason: "not-redeemable" };
  if (!isSameInviteScope(classifyInviteScope(match), credential.scope)) {
    return { status: "stale", reason: "scope-mismatch" };
  }
  // generic viewer は「受理済み権威モデルが選ぶ現在の 1 行」と一致していることまで求める。
  // id が redeemable でも、別の generic viewer 行が現在の権威になっていれば
  // この資格を配ってはならない（0027 の supersede により通常は起こらないが、
  // client は server の状態を推定せず、スナップショットが示すものに従う）。
  if (credential.scope.kind === "generic" && credential.scope.role === "viewer") {
    const currentGeneric = findActiveGenericViewerInvite(invites, nowMs);
    if (!currentGeneric || currentGeneric.id !== credential.inviteId) {
      return { status: "stale", reason: "not-current-generic-viewer-authority" };
    }
  }
  return { status: "current", invite: match };
}
