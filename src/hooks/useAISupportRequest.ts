import { useCallback, useEffect, useRef, useState } from "react";
import { getServices } from "@/services/registry";
import { AISupportServiceError } from "@/services/aiServiceError";
import { AIRequestKind, AIRequestStatus, AISupportResponse } from "@/types/ai";
import { useLocale } from "@/context/LocaleContext";
import {
  AiOperationOwner,
  isAiOperationOwnerCurrent,
  useAiOperationOwner,
} from "@/ai/aiOperationOwner";
import { generateId } from "@/utils/id";
import {
  clearPendingAiRequest,
  getPendingAiRequest,
  PersistedAiPendingRequest,
  savePendingAiRequest,
} from "@/storage/aiPendingRequestRepository";

/** 「保留中の論理的依頼」。同じkind/inputでの再試行は、この中のrequestIdを再利用する。 */
interface PendingRequest {
  requestId: string;
  kind: AIRequestKind;
  input: string;
}

/**
 * - "pending": 端末内の保留中依頼を読み込み中（読み込み完了までAI送信は一切行わない）。
 * - "ready": 読み込み完了。送信してよい。
 * - "failed": 読み込みに失敗した（破損データ等）。保存済みrequestIdを取りこぼす恐れが
 *   あるため、自動的に新規requestIdで続行せず、ユーザーの明示的な操作を待つ。
 * - "conflict": 保存済みの保留中依頼があるが、現在のkind/inputと一致しない。
 *   暗黙に上書き・破棄せず、ユーザーの明示的な選択（続ける／破棄する）を待つ。
 */
export type PendingRestoreStatus = "pending" | "ready" | "failed" | "conflict";

function logDev(message: string, error: unknown): void {
  if (__DEV__) {
    // eslint-disable-next-line no-console -- 開発時のみ、原因調査用に出力する
    console.error(`[aiPendingRequest] ${message}`, error);
  }
}

/**
 * P0051 (QA-F007-C19): status/response/error/restoreStatus/conflictingRequestを
 * 「どのidentityの結果か」というownerIdentityKeyと共に1つのstateへ束ねる。
 * これにより、呼び出し元へ公開する値をrender時点で
 * `ownerIdentityKey === 現在のidentityKey`かどうかだけで機械的にmaskできる
 * （useEffectによる非同期リセットを待たず、identity切替直後の最初のrenderから
 * 前の持ち主の値を一切公開しない）。
 */
export interface OwnedVisibleState {
  ownerIdentityKey: string;
  status: AIRequestStatus;
  response: AISupportResponse | null;
  error: string | null;
  restoreStatus: PendingRestoreStatus;
  conflictingRequest: PersistedAiPendingRequest | null;
}

function initialOwnedState(identityKey: string): OwnedVisibleState {
  return {
    ownerIdentityKey: identityKey,
    status: "idle",
    response: null,
    error: null,
    restoreStatus: "pending",
    conflictingRequest: null,
  };
}

/**
 * P0051: pure関数として切り出し、Reactのrender/effectを一切介さずに直接検証できるように
 * する（「テストがReactのact()自動flushによって、reset effectが走る前の1フレームの
 * 漏洩を見えなくしてしまう」という穴を作らないため）。
 */
export function selectVisibleRequestState(
  owned: OwnedVisibleState,
  currentIdentityKey: string
): {
  status: AIRequestStatus;
  response: AISupportResponse | null;
  error: string | null;
  restoreStatus: PendingRestoreStatus;
  conflictingRequest: PersistedAiPendingRequest | null;
} {
  const isOwnerCurrent = owned.ownerIdentityKey === currentIdentityKey;
  return {
    status: isOwnerCurrent ? owned.status : "idle",
    response: isOwnerCurrent ? owned.response : null,
    error: isOwnerCurrent ? owned.error : null,
    restoreStatus: isOwnerCurrent ? owned.restoreStatus : "pending",
    conflictingRequest: isOwnerCurrent ? owned.conflictingRequest : null,
  };
}

/**
 * AI処理画面の状態遷移（idle→loading→success/error）を管理するhook。
 * kindがnullの間は何もしない（入力が確定するまで待つ）。
 *
 * 二重送信防止: 前回のリクエストが完了する前にrun/retryが呼ばれても無視する
 * （runningRefはレンダーを跨いで即座に参照できる必要があるためstateではなくrefで持つ）。
 *
 * 単独修正(2026-08): requestIdは「通信試行」ではなく「ユーザーが行った1回の論理的な
 * AI依頼」に対して1つだけ発行する。同じkind/inputでの再試行（通信タイムアウト・切断・
 * 5xx・バックグラウンド復帰後の再試行・自動リトライ等、経路を問わず）は、
 * pendingRequestRef（Reactの再レンダーの影響を受けないref）に保持した既存の
 * requestIdをそのまま再利用し、新規発行しない。
 *
 * 単独最終修正(2026-08): pendingRequestRefはプロセスの再起動をまたげないため、
 * aiPendingRequestRepository（AsyncStorage）へも同じ内容を永続化する。
 * 送信より前に保存し、保存が失敗したら送信しない。マウント時にはまず永続化された
 * 保留中依頼を読み込み、読み込みが終わるまで送信しない。読み込んだ内容が現在の
 * kind/inputと一致すればそのrequestIdを再利用し、一致しなければ（"conflict"）／
 * 読み込み自体に失敗すれば（"failed"）、自動的に新規requestIdへフォールバックせず、
 * 呼び出し側（画面）に明示的な選択を委ねる。
 *
 * P0050/P0051/P0052 (SEC-F007-002): 可視stateをowner-taggedにしてrender時点でmaskし、
 * 保留中依頼の永続化をowner-partitionedにした。
 *
 * P0148 (SEC-F007-005) — 本hookの所有権モデルを根本から変更した:
 *
 *   従来は「今のidentityKey」を毎レンダー読み直し、identityが変わったら
 *   **新しい持ち主として同じroute inputを読み込み直し・自動送信**していた。
 *   これは前の持ち主の私的な入力内容を、本人の明示的な操作なしに別アカウントとして
 *   サーバーへ送信し、そのアカウントの利用回数を消費させる経路になっていた。
 *
 *   現在は `useAiOperationOwner` が**マウント中に一度だけ**所有者
 *   （正確な userId + sessionInstanceId）を確定する。権威identityがそれと
 *   一致しなくなったら、この依頼は `stale` であり、
 *     - 読み込み直さない / 送信しない / 保存しない / clearしない
 *     - 表示もしない（既存のrender-time maskingがそのまま効く）
 *   新しい持ち主がAI依頼を行えるのは、**新しい明示的なユーザー操作**からのみ
 *   （画面側は `ownerDisposition === "stale"` を見てAIホームへ戻す）。
 *
 *   identityの権威は AuthContext のReact stateではなく `authSessionIdentityStore`。
 *   AuthContextは `setCurrentAuthIdentity()` の**後**に setState するため、
 *   セキュリティ判断をAuthContextのclosureに依存させてはならない。
 *
 *   同一所有者内のretry・保留中requestIdのdurabilityは一切弱めていない。
 *
 * P0150 (SEC-F007-006): 所有者を**このhookが捕捉しない**ようにした。
 *   P0148では `useAiOperationOwner(!authLoading)` が「マウント時点の権威identity」を
 *   所有者にしていたため、AIホームでの送信操作からこのhookのマウントまでの間に
 *   identityが切り替わると、前の持ち主の入力を新しい持ち主の依頼として再束縛できた。
 *   現在は**明示的なユーザー操作の時点で捕捉された所有者**（`aiIntentHandoffStore` 経由）を
 *   呼び出し元から受け取るだけで、hook側は一切捕捉しない。
 *   `capturedOwner === null`（意図が未解決・不正・期限切れ・所有者不一致）の場合は
 *   `disposition === "capturing"` のまま、読み込みも送信も行わない（fail-closed）。
 *   これに伴い AuthContext（`loading`）への依存も不要になったため撤去した
 *   （所有者は既に確定した認証状態の下で捕捉されている）。
 */
export function useAISupportRequest(
  kind: AIRequestKind | null,
  input: string,
  capturedOwner: AiOperationOwner | null
) {
  const { t } = useLocale();
  const {
    owner,
    disposition,
    currentIdentityKey,
    ownerIdentityKey,
  } = useAiOperationOwner(capturedOwner);
  const isOwned = disposition === "owned";

  const [owned, setOwned] = useState<OwnedVisibleState>(() =>
    initialOwnedState(ownerIdentityKey)
  );
  const { restoreStatus } = owned;

  const runningRef = useRef(false);
  const pendingRequestRef = useRef<PendingRequest | null>(null);
  const conflictingRequestRef = useRef<PersistedAiPendingRequest | null>(null);
  const staleDiscardedRef = useRef(false);

  /**
   * 所有者は不変のため、この依頼が扱ってよい永続化スコープ（ownerUserId）も不変。
   * 「今ログインしているユーザー」ではなく「この依頼を始めたユーザー」で読み書きする。
   */
  const ownerUserId = owner?.userId ?? null;

  const loadPending = useCallback(async () => {
    if (!isAiOperationOwnerCurrent(owner) || !owner) return;
    const ownerKey = ownerIdentityKey;
    setOwned((prev) => ({
      ...prev,
      ownerIdentityKey: ownerKey,
      restoreStatus: "pending",
      conflictingRequest: null,
    }));
    try {
      const persisted = await getPendingAiRequest(ownerUserId);
      if (!isAiOperationOwnerCurrent(owner)) return;
      if (!persisted) {
        pendingRequestRef.current = null;
        conflictingRequestRef.current = null;
        setOwned((prev) => ({
          ...prev,
          ownerIdentityKey: ownerKey,
          restoreStatus: "ready",
          conflictingRequest: null,
        }));
        return;
      }
      if (kind && persisted.kind === kind && persisted.input === input) {
        pendingRequestRef.current = {
          requestId: persisted.requestId,
          kind: persisted.kind,
          input: persisted.input,
        };
        conflictingRequestRef.current = null;
        setOwned((prev) => ({
          ...prev,
          ownerIdentityKey: ownerKey,
          restoreStatus: "ready",
          conflictingRequest: null,
        }));
      } else {
        pendingRequestRef.current = null;
        conflictingRequestRef.current = persisted;
        setOwned((prev) => ({
          ...prev,
          ownerIdentityKey: ownerKey,
          restoreStatus: "conflict",
          conflictingRequest: persisted,
        }));
      }
    } catch (e) {
      if (!isAiOperationOwnerCurrent(owner)) return;
      logDev("restore failed", e);
      setOwned((prev) => ({ ...prev, ownerIdentityKey: ownerKey, restoreStatus: "failed" }));
    }
  }, [kind, input, owner, ownerIdentityKey, ownerUserId]);

  useEffect(() => {
    // 所有者がまだ確定していない（認証復元中）間は、読み込みも送信も行わない。
    if (disposition === "capturing") return;
    if (disposition === "stale") {
      // P0148: この依頼は前の持ち主のもの。**新しい持ち主へ引き継がない**。
      // 内部制御状態を1回破棄し、読み込み直しも送信もしない
      // （可視stateはownerIdentityKey不一致によりrender時点で既にmask済み）。
      //
      // restoreStatusも"pending"へ戻すのが重要: A→ゲスト→Aのように元の所有者へ
      // 戻った場合、restoreStatusが"ready"のまま残っていると、復元（loadPending）が
      // 終わる前にrunが走り、破棄済みのpendingRequestRefの代わりに**新しいrequestIdを
      // 発行して**送信してしまう（同じ論理依頼が2つのrequestIdに分裂し、
      // サーバー側の冪等判定をすり抜けて利用回数を二重消費しうる）。
      if (!staleDiscardedRef.current) {
        staleDiscardedRef.current = true;
        pendingRequestRef.current = null;
        conflictingRequestRef.current = null;
        runningRef.current = false;
        setOwned((prev) => initialOwnedState(prev.ownerIdentityKey));
      }
      return;
    }
    staleDiscardedRef.current = false;
    loadPending();
  }, [loadPending, disposition]);

  const run = useCallback(async () => {
    if (!kind) return;
    if (!isOwned || !owner) return;
    if (restoreStatus !== "ready") return;
    if (runningRef.current) return;
    // 副作用（永続化・送信）を始める直前に、権威identityが今も所有者と一致するかを
    // freshに確認する（renderからeffect実行までの間に切り替わっている可能性がある）。
    if (!isAiOperationOwnerCurrent(owner)) return;
    runningRef.current = true;
    const ownerKey = ownerIdentityKey;
    setOwned((prev) => ({ ...prev, ownerIdentityKey: ownerKey, status: "loading", error: null }));
    try {
      const pending = pendingRequestRef.current;
      let active: PendingRequest;
      if (pending && pending.kind === kind && pending.input === input) {
        active = pending;
      } else {
        const fresh: PendingRequest = { requestId: generateId("ai_req"), kind, input };
        try {
          // この依頼を開始した所有者のスコープへ刻む。clearPendingAiRequest()が後で
          // 失敗しても、所有者不一致のため別ユーザー・未ログイン状態からは
          // 復元・自動再送されない。
          await savePendingAiRequest({
            ...fresh,
            createdAt: new Date().toISOString(),
            ownerUserId,
          });
        } catch (e) {
          logDev("save failed", e);
          if (isAiOperationOwnerCurrent(owner)) {
            setOwned((prev) => ({
              ...prev,
              ownerIdentityKey: ownerKey,
              status: "error",
              error: t("aiProcessing.pendingSaveFailedFallback"),
            }));
          }
          return;
        }
        if (!isAiOperationOwnerCurrent(owner)) {
          // 保存が完了するまでの間に所有者ではなくなった。保存済みの依頼は
          // その持ち主自身の所有物として残し、送信は行わない。
          return;
        }
        pendingRequestRef.current = fresh;
        active = fresh;
      }

      // 依頼開始時の所有者をサービス境界へ渡す。応答が返るまでの間に
      // ログアウトやアカウント切替が起きても、別の利用者へ結果を反映しない。
      const result = await getServices().aiService.generateSupport(
        { kind, input, requestId: active.requestId },
        t,
        owner
      );
      if (!isAiOperationOwnerCurrent(owner)) {
        // ログアウト、別ユーザーへの切替、または同一ユーザーの新セッションへの
        // 切替が完了する間に応答が届いた。前の持ち主の内容を今の画面・今の
        // 持ち主へ反映しない。
        return;
      }
      pendingRequestRef.current = null;
      setOwned((prev) => ({
        ...prev,
        ownerIdentityKey: ownerKey,
        status: "success",
        response: result,
      }));
      try {
        // requestId・所有者の両方が一致する場合のみ削除する
        // （owner-partitioned storage + module-level queueで直列化済み）。
        await clearPendingAiRequest({ ownerUserId, expectedRequestId: active.requestId });
      } catch (e) {
        // 削除失敗はログのみに留め、成功状態は維持する（次回起動時にconfirmed済みの
        // 同じ回答を再取得できる状態のまま残るだけで、実害はない）。
        logDev("clear failed", e);
      }
    } catch (e) {
      // AISupportServiceErrorはAIService実装側が「ユーザーへ見せてよい」と判断した
      // 安全なメッセージのみを持つため、それに限りそのまま表示する。
      // それ以外の予期しない例外は内部詳細を漏らさないよう汎用メッセージへ丸める。
      // pendingRequestRef・永続化された保留中依頼は破棄しない（次のretryが同じ
      // requestIdを再利用するため）。
      if (isAiOperationOwnerCurrent(owner)) {
        setOwned((prev) => ({
          ...prev,
          ownerIdentityKey: ownerKey,
          status: "error",
          error: e instanceof AISupportServiceError ? e.message : t("aiProcessing.errorTitleFallback"),
        }));
      }
    } finally {
      // 所有者でなくなっている場合はrunningRefに触らない（stale側の後始末は
      // disposition="stale"のeffectが1回だけ行う）。
      if (isAiOperationOwnerCurrent(owner)) {
        runningRef.current = false;
      }
    }
  }, [kind, input, t, restoreStatus, isOwned, owner, ownerIdentityKey, ownerUserId]);

  useEffect(() => {
    run();
  }, [run]);

  /** ユーザーが未完了依頼を明示的に破棄する（読み込み失敗時・内容不一致時の両方で使う）。 */
  const discardPending = useCallback(async () => {
    if (!isAiOperationOwnerCurrent(owner) || !owner) return;
    const ownerKey = ownerIdentityKey;
    const conflicting = conflictingRequestRef.current;
    try {
      // 現在の所有者・（分かれば）discard対象のrequestIdの両方で検証してから削除する。
      // 読み込み失敗（"failed"）で内容が不明な場合はrequestId無しで所有者チェックのみ
      // 行う（getPendingAiRequest自体が既にこの所有者向けであることを保証済み）。
      await clearPendingAiRequest(
        conflicting
          ? { ownerUserId, expectedRequestId: conflicting.requestId }
          : { ownerUserId }
      );
    } catch (e) {
      logDev("discard failed", e);
    }
    if (!isAiOperationOwnerCurrent(owner)) return;
    pendingRequestRef.current = null;
    conflictingRequestRef.current = null;
    setOwned((prev) => ({
      ...prev,
      ownerIdentityKey: ownerKey,
      restoreStatus: "ready",
      conflictingRequest: null,
    }));
  }, [owner, ownerIdentityKey, ownerUserId]);

  // P0051: render-time owner masking。ownerIdentityKeyが現在のidentityKeyと一致しない
  // 場合（identity切替直後、reset effectがまだ走っていない最初のrenderを含む）、
  // 前の持ち主の値を一切公開しない。
  const visible = selectVisibleRequestState(owned, currentIdentityKey);

  return {
    ...visible,
    /**
     * P0148: この依頼の不変の所有者。画面側は成功後の終端副作用（利用回数・履歴・
     * 結果の公開・遷移）の直前に、この所有者が今も権威identityかを確認する。
     * nullは「所有者未確定」＝副作用を実行してはならない状態。
     */
    operationOwner: owner,
    /** "capturing" | "owned" | "stale"。画面側は"stale"で安全に離脱する。 */
    ownerDisposition: disposition,
    retry: run,
    retryRestore: loadPending,
    discardPending,
  };
}
