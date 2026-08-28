import {
  classifyInviteScope,
  countsTowardMemberSlot,
  findActiveGenericViewerInvite,
  isInviteRedeemable,
  isSameInviteScope,
  normalizeInviteRecipient,
} from "@/utils/inviteAuthority";
import { CalendarInvite } from "@/types/sharing";

/**
 * P0178 / CORRECT-F024-003 — 4 概念の分離そのものを検証する。
 *
 * ```text
 * PENDING_FOR_SLOT_COUNT        枠を消費するか        権威 = migration 0018 の count
 * REDEEMABLE_TOKEN_AUTHORITY    token がまだ使えるか  権威 = migration 0020 G2
 * INVITE_ISSUANCE_SCOPE         誰宛に出したか        権威 = invitee_email の有無
 * CLIENT_VISIBLE_CURRENT_...    画面が今持つ資格      権威ではない（表示専用）
 * ```
 *
 * 特に **redeemable と slot-count は別物**である。この 2 つを 1 つの
 * `isActiveInvite` に潰したことが 0026 と旧 settings.tsx の両方のバグの原因だった。
 */

const NOW = Date.parse("2026-08-15T00:00:00.000Z");
const FUTURE = "2026-09-01T00:00:00.000Z";
const PAST = "2026-08-01T00:00:00.000Z";

function invite(over: Partial<CalendarInvite> = {}): CalendarInvite {
  return {
    id: "inv-1",
    calendarId: "cal-1",
    role: "viewer",
    createdBy: "user-1",
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  };
}

describe("normalizeInviteRecipient", () => {
  it("trim + lowercase し、空文字は null にする（0027 の nullif(lower(trim(...))) と同じ）", () => {
    expect(normalizeInviteRecipient("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeInviteRecipient("   ")).toBeNull();
    expect(normalizeInviteRecipient("")).toBeNull();
    expect(normalizeInviteRecipient(null)).toBeNull();
    expect(normalizeInviteRecipient(undefined)).toBeNull();
  });
});

describe("classifyInviteScope / isSameInviteScope（INVITE_ISSUANCE_SCOPE）", () => {
  it("invitee_email があれば targeted、無ければ generic", () => {
    expect(classifyInviteScope(invite({ inviteeEmail: "a@b.c" })).kind).toBe("targeted");
    expect(classifyInviteScope(invite()).kind).toBe("generic");
    // 空白だけの値は「宛先なし」と同じに正規化される。
    expect(classifyInviteScope(invite({ inviteeEmail: "   " })).kind).toBe("generic");
  });

  it("targeted は role-independent（同一宛先なら editor と viewer が同一スコープ）", () => {
    const a = classifyInviteScope(invite({ role: "editor", inviteeEmail: "Alice@Example.com" }));
    const b = classifyInviteScope(invite({ role: "viewer", inviteeEmail: "alice@example.com" }));
    expect(isSameInviteScope(a, b)).toBe(true);
  });

  it("generic は role-specific（editor リンクと viewer リンクは別スコープ）", () => {
    const a = classifyInviteScope(invite({ role: "editor" }));
    const b = classifyInviteScope(invite({ role: "viewer" }));
    expect(isSameInviteScope(a, b)).toBe(false);
  });

  it("targeted と generic は決して同一スコープにならない", () => {
    const t = classifyInviteScope(invite({ role: "viewer", inviteeEmail: "alice@example.com" }));
    const g = classifyInviteScope(invite({ role: "viewer" }));
    expect(isSameInviteScope(t, g)).toBe(false);
  });

  it("カレンダーが違えば同一スコープにならない", () => {
    const a = classifyInviteScope(invite({ calendarId: "cal-1" }));
    const b = classifyInviteScope(invite({ calendarId: "cal-2" }));
    expect(isSameInviteScope(a, b)).toBe(false);
  });
});

describe("isInviteRedeemable（REDEEMABLE_TOKEN_AUTHORITY = 0020 G2）", () => {
  it("未取消・未期限切れなら redeemable", () => {
    expect(isInviteRedeemable(invite(), NOW)).toBe(true);
  });

  it("revoked / expired は redeemable でない", () => {
    expect(isInviteRedeemable(invite({ revokedAt: PAST }), NOW)).toBe(false);
    expect(isInviteRedeemable(invite({ expiresAt: PAST }), NOW)).toBe(false);
  });

  it("**accepted 済みでも redeemable のまま**（0020 G2 は accepted_at を拒否条件にしない）", () => {
    expect(isInviteRedeemable(invite({ acceptedAt: PAST }), NOW)).toBe(true);
  });

  it("**declined 済みでも token 経路では redeemable のまま**（by_id 経路だけが declined を見る）", () => {
    expect(isInviteRedeemable(invite({ declinedAt: PAST }), NOW)).toBe(true);
  });

  it("expiresAt が解釈不能なら fail-closed（redeemable でない）", () => {
    expect(isInviteRedeemable(invite({ expiresAt: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("countsTowardMemberSlot（PENDING_FOR_SLOT_COUNT = 0018 の count）", () => {
  it("未取消・未期限切れ・未受諾・未拒否のときだけ枠を消費する", () => {
    expect(countsTowardMemberSlot(invite(), NOW)).toBe(true);
  });

  it("受諾済みは枠を消費しない（本人は既に calendar_members に居るため二重計上になる）", () => {
    expect(countsTowardMemberSlot(invite({ acceptedAt: PAST }), NOW)).toBe(false);
  });

  it("拒否済みは枠を消費しない", () => {
    expect(countsTowardMemberSlot(invite({ declinedAt: PAST }), NOW)).toBe(false);
  });

  it("**redeemable と一致しない**——受諾済み invite は redeemable かつ枠を消費しない", () => {
    const accepted = invite({ acceptedAt: PAST });
    expect(isInviteRedeemable(accepted, NOW)).toBe(true);
    expect(countsTowardMemberSlot(accepted, NOW)).toBe(false);
    // この非一致こそが 2 概念を別々にモデル化する理由であり、不整合ではない。
  });
});

describe("findActiveGenericViewerInvite", () => {
  it("targeted な viewer 招待しか無ければ undefined を返す", () => {
    const found = findActiveGenericViewerInvite(
      [invite({ id: "t1", role: "viewer", inviteeEmail: "alice@example.com" })],
      NOW
    );
    expect(found).toBeUndefined();
  });

  it("generic viewer 招待があればそれを返す", () => {
    const found = findActiveGenericViewerInvite(
      [
        invite({ id: "t1", role: "viewer", inviteeEmail: "alice@example.com" }),
        invite({ id: "g1", role: "viewer" }),
      ],
      NOW
    );
    expect(found?.id).toBe("g1");
  });

  it("generic な editor 招待は viewer リンク権威にならない", () => {
    expect(findActiveGenericViewerInvite([invite({ id: "ge", role: "editor" })], NOW)).toBeUndefined();
  });

  it("revoked / expired な generic viewer は権威にならない", () => {
    expect(
      findActiveGenericViewerInvite([invite({ id: "g1", revokedAt: PAST })], NOW)
    ).toBeUndefined();
    expect(
      findActiveGenericViewerInvite([invite({ id: "g2", expiresAt: PAST })], NOW)
    ).toBeUndefined();
  });

  it("受諾済みの generic viewer は依然として現在の資格である", () => {
    const found = findActiveGenericViewerInvite([invite({ id: "g1", acceptedAt: PAST })], NOW);
    expect(found?.id).toBe("g1");
  });

  it("空配列でも例外にならない", () => {
    expect(findActiveGenericViewerInvite([], NOW)).toBeUndefined();
  });
});
