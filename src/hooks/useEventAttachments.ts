import { useCallback, useEffect, useRef, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as Crypto from "expo-crypto";
import NetInfo from "@react-native-community/netinfo";
import {
  AttachmentDraft,
  AttachmentErrorReason,
  AttachmentQuotaStatus,
  EventAttachment,
  ProcessedImage,
} from "@/types/attachment";
import { PremiumStatus } from "@/types/premium";
import { getAttachmentLimits } from "@/constants/attachmentLimits";
import {
  canAddMoreImages,
  canSaveProcessedImage,
  getEffectiveAttachmentPlan,
} from "@/services/attachmentQuotaService";
import { AttachmentProcessingError, processPickedImage } from "@/services/attachmentImageProcessor";
import {
  CloudAttachmentRemoveStaleError,
  CloudAttachmentStaleAfterCommitError,
  CloudAttachmentStaleBeforeCommitError,
  cloudAttachmentRepository,
  queueCloudAttachmentDeleteIntent,
} from "@/services/cloudAttachmentRepository";
import { localAttachmentRepository } from "@/services/localAttachmentRepository";
import { deleteDraftAttachmentFile, saveDraftAttachmentFile } from "@/services/attachmentDraftStorage";
import { runPostPrimaryStep } from "@/utils/postPrimary";
import { getLocalAttachmentsTotalBytes } from "@/storage/eventAttachmentsRepository";
import { fetchAttachmentQuotaStatus } from "@/services/remoteAttachmentRepository";
import { SharedOperationIdentity, isCurrentSharedMutationIdentity } from "@/auth/sharedMutationIdentity";

/**
 * NormalEventFormから使う唯一の入口。
 *
 * "create"モード（新規予定作成画面）: 画面表示時に発行されるeventIdは、予定保存が成功する
 * まではevent_attachments.event_id（events(id)への外部キー、即時検証）の値として一切使わない。
 * 画像はまず"draft-ready"としてアプリ管理領域のドラフトディレクトリにのみ保存し、
 * commitDraftAttachments()が呼ばれて初めて正式なrepository（Storage+DB、または端末内正式領域+
 * メタデータ）へ登録する。
 *
 * "edit"モード（既存予定編集画面）: 既にevents行が存在するため、従来通り選択直後に
 * 即時アップロード・登録する（この挙動は変更しない）。
 *
 * どちらのモードでも通知の再予約（notificationService.ts）は一切呼ばない。
 *
 * Round 13（SEC-F007-004/SEC-F007-001残存、P1-3）: 「identityRefを毎レンダー同期する」だけの
 * 設計（Round12）に加えて、各非同期操作が自分自身の開始時点のスコープ（storage種別・
 * identity・eventId・calendarId）を`AttachmentOperationScope`として固定で1回だけ捕捉し
 * （captureAttachmentScope）、以後はこの捕捉済みスコープが「今も現在のものか」だけを
 * 確認する（isAttachmentScopeCurrent）。生きているrefを都度読み直す設計とは異なり、
 * 操作が開始した後にparamsが変化しても（identity-key remount契約を経由しない将来の
 * 呼び出しが万一追加されたとしても）、その操作は自分が開始した時点のscopeとの一致でしか
 * 判定しないため、途中から別のidentityへ乗り換えることがない。isCloudEvent=trueなのに
 * identityが欠落している場合（画面remount直前の短い遷移window等）はローカルrepositoryへ
 * 一切フォールバックせず、`storage: "cloud-blocked"`として添付操作そのものを一時的に
 * 完全停止する（fail-closed）。
 */
export type AttachmentFormMode = "create" | "edit";

interface UseEventAttachmentsCommonParams {
  mode: AttachmentFormMode;
  /** editモード: 既存event.id。createモード: 画面表示時に先行生成したID（events行はまだ無い） */
  eventId: string;
  /** createモードのみ必須。ドラフトファイルの保存先を識別する、eventIdとは別のID */
  draftSessionId?: string;
  /**
   * 端末内（ローカル）予定のみ実際に使われる。クラウド予定は、操作中ユーザー本人の
   * このdevicePlan（PremiumContext由来）を一切参照せず、calendarIdから解決した
   * カレンダー所有者の実プラン（get_attachment_quota_status RPC）を使う。
   */
  devicePlan: PremiumStatus;
}

export type UseEventAttachmentsParams =
  | (UseEventAttachmentsCommonParams & { isCloudEvent: false })
  | (UseEventAttachmentsCommonParams & {
      isCloudEvent: true;
      calendarId: string;
      /**
       * Round13、P1-3: nullを許容する（呼び出し元がisCloudEvent=trueなのに
       * identityを用意できていない短い遷移windowを、ローカルへのフォールバックではなく
       * "cloud-blocked"として正直に表現するため）。
       */
      identity: SharedOperationIdentity | null;
    });

/** identityはHook側がスコープ（Hook初期化時点で固定）から補うため、呼び出し元は渡さない。 */
export interface CommitAttachmentsContext {
  eventId: string;
  calendarId?: string;
}

export interface CommitResult {
  succeededCount: number;
  failedCount: number;
  /**
   * コミット処理の途中でidentityがstale化した、またはcloud-blocked状態のまま
   * コミットを試みた場合にtrue。残りの下書きはコミットせず打ち切る。この場合
   * succeededCount/failedCountは打ち切り時点までの結果であり、呼び出し元
   * （NormalEventForm）はこれがtrueのとき成功Alert・ナビゲーションを行ってはならない
   * （画面は既にidentity変化によりremountされているはず）。
   */
  stoppedDueToStaleIdentity: boolean;
}

export interface UseEventAttachmentsResult {
  attachments: EventAttachment[];
  drafts: AttachmentDraft[];
  deletingIds: Set<string>;
  loading: boolean;
  limits: { maxImagesPerEvent: number; plan: PremiumStatus };
  lastError: AttachmentErrorReason | null;
  clearLastError: () => void;
  addImage: () => Promise<void>;
  retryAttachment: (id: string) => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  /** createモード専用。予定本体の保存成功後に呼ぶ。editモードでは何もせず{0,0,false}を返す。 */
  commitDraftAttachments: (context: CommitAttachmentsContext) => Promise<CommitResult>;
  /** createモード専用。予定保存前にキャンセルされた場合、ドラフト一式を破棄する。 */
  discardDraftAttachments: () => Promise<void>;
}

/**
 * Round13、P1-3: 1回の非同期操作が開始時点で捕捉する不変のスナップショット。
 * "cloud-blocked"はisCloudEvent=trueなのにidentityが欠落している状態
 * （ローカルへフォールバックせず添付操作を完全停止するため専用の値を持つ）。
 */
interface AttachmentOperationScope {
  storage: "local" | "cloud" | "cloud-blocked";
  identity: SharedOperationIdentity | null;
  eventId: string;
  calendarId: string | null;
  generation: number;
}

function mapServerError(e: unknown): AttachmentErrorReason {
  const message = e instanceof Error ? e.message : "";
  if (message.includes("attachment_event_limit")) return "event-limit";
  if (message.includes("attachment_quota_exceeded")) return "total-quota";
  if (message.includes("attachment_too_large")) return "too-large-after-compression";
  // friendlyError.tsのRLS拒否検出と同じ文字列に揃える（PostgRESTのRLS違反メッセージ）。
  if (message.includes("row-level security") || message.includes("permission")) {
    return "permission-denied";
  }
  return "upload-failed";
}

/**
 * create()系のstale専用シグナル2種のいずれか。通常の失敗（mapServerError対象）とは区別する。
 * `CloudAttachmentCleanupTrackingFailedError`（pending intentの永続化自体が失敗した場合）は
 * identityのstale化とは無関係のローカル永続化障害のため、ここに含めず通常の失敗として
 * `mapServerError`経由でユーザーへ知らせる。
 */
function isCloudCreateStaleError(e: unknown): boolean {
  return (
    e instanceof CloudAttachmentStaleBeforeCommitError || e instanceof CloudAttachmentStaleAfterCommitError
  );
}

export function useEventAttachments(params: UseEventAttachmentsParams): UseEventAttachmentsResult {
  const { mode, eventId, draftSessionId, isCloudEvent, devicePlan } = params;
  const calendarId = params.isCloudEvent ? params.calendarId : null;
  const paramsIdentity = params.isCloudEvent ? params.identity : null;

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Round13、P1-3: このHookインスタンスの生存期間中に起こりうるスコープの変化
  // （isCloudEventのローカル⇔クラウド切替、calendarIdの切替、identityの欠落⇔復帰）を
  // 検知するたびに世代を進める。各非同期操作はcaptureAttachmentScope()で開始時点の
  // スコープを1回だけ捕捉し、以後はこのgenerationとの一致・identityの現在性だけを見る
  // （生きているrefを操作の途中で都度読み直さない）。
  const generationRef = useRef(0);
  const scopeRef = useRef<AttachmentOperationScope | null>(null);
  {
    const storage: AttachmentOperationScope["storage"] = !isCloudEvent
      ? "local"
      : paramsIdentity
        ? "cloud"
        : "cloud-blocked";
    const prev = scopeRef.current;
    const changed =
      !prev ||
      prev.storage !== storage ||
      prev.eventId !== eventId ||
      prev.calendarId !== calendarId ||
      prev.identity?.userId !== paramsIdentity?.userId ||
      prev.identity?.sessionInstanceId !== paramsIdentity?.sessionInstanceId;
    if (changed) generationRef.current += 1;
    scopeRef.current = { storage, identity: paramsIdentity, eventId, calendarId, generation: generationRef.current };
  }

  const captureAttachmentScope = useCallback((): AttachmentOperationScope => scopeRef.current!, []);

  /** 捕捉済みscopeが今も現在のものか（世代が一致し、cloudならidentityも現在値と一致するか）。 */
  const isAttachmentScopeCurrent = useCallback((scope: AttachmentOperationScope): boolean => {
    if (!mountedRef.current) return false;
    if (scope.generation !== generationRef.current) return false;
    if (scope.storage === "cloud") {
      return !!scope.identity && isCurrentSharedMutationIdentity(scope.identity);
    }
    return true;
  }, []);

  const [attachments, setAttachments] = useState<EventAttachment[]>([]);
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(mode === "edit");
  const [lastError, setLastError] = useState<AttachmentErrorReason | null>(null);
  // クラウド予定のみ使う。カレンダー所有者の実プランに基づく上限・現在値・追加可否
  // （get_attachment_quota_status RPC、FP-004）。未取得・取得失敗時はnullのままとし、
  // 呼び出し側は必ず安全側(free相当)にフォールバックする。ローカル予定・cloud-blocked中は常にnull。
  const [quotaStatus, setQuotaStatus] = useState<AttachmentQuotaStatus | null>(null);

  // quotaStatus.maxFilesPerEventは無料/プレミアムの固定枚数(1/5)と一致するため、
  // このRPC結果だけから「所有者が実際にどちらの階層か」を安全に逆引きできる
  // （resolve_owner_plan/enforce_attachment_quotaと同じ固定値を前提にしている）。
  // 圧縮時の目標長辺(maxLongEdge)やエラー文言の free/premium 出し分けにのみ使う。
  const cloudOwnerPlan: PremiumStatus | null =
    isCloudEvent && quotaStatus
      ? quotaStatus.maxFilesPerEvent > getAttachmentLimits("free").maxImagesPerEvent
        ? "premium"
        : "free"
      : null;
  const effectivePlan = getEffectiveAttachmentPlan(isCloudEvent, devicePlan, cloudOwnerPlan);

  // 同じ種類の要求（quota取得）が短時間に複数回発火した場合に、後発の要求の結果だけを
  // 反映する（out-of-order応答対策）。スコープの一致確認とは独立した、同一スコープ内での
  // 要求どうしの前後関係を追うための世代カウンタ。
  const quotaGenerationRef = useRef(0);

  const refreshQuotaStatus = useCallback(() => {
    const scope = captureAttachmentScope();
    if (scope.storage !== "cloud" || !scope.calendarId || !scope.identity) return;
    const identity = scope.identity;
    const gen = ++quotaGenerationRef.current;
    fetchAttachmentQuotaStatus(scope.calendarId, identity, eventId)
      .then((status) => {
        if (quotaGenerationRef.current !== gen || !isAttachmentScopeCurrent(scope)) return;
        setQuotaStatus(status);
      })
      .catch(() => {
        if (quotaGenerationRef.current !== gen || !isAttachmentScopeCurrent(scope)) return;
        setQuotaStatus(null);
      });
  }, [captureAttachmentScope, isAttachmentScopeCurrent, eventId]);

  // マウント時・カレンダー切替時・identity復帰時の取得。createモードは予定保存前でevents行が
  // まだ無いため、event_idは渡さない（RPC側はp_event_id省略時0件として扱う）。
  useEffect(() => {
    const scope = captureAttachmentScope();
    if (scope.storage !== "cloud" || !scope.calendarId || !scope.identity) {
      setQuotaStatus(null);
      return;
    }
    const identity = scope.identity;
    const gen = ++quotaGenerationRef.current;
    const targetEventId = mode === "edit" ? eventId : undefined;
    fetchAttachmentQuotaStatus(scope.calendarId, identity, targetEventId)
      .then((status) => {
        if (quotaGenerationRef.current !== gen || !isAttachmentScopeCurrent(scope)) return;
        setQuotaStatus(status);
      })
      .catch(() => {
        if (quotaGenerationRef.current !== gen || !isAttachmentScopeCurrent(scope)) return;
        setQuotaStatus(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captureAttachmentScope/isAttachmentScopeCurrentは安定参照。スコープ自体の変化はscopeRef.current.generationの更新（レンダーごとの同期）で検知する
  }, [isCloudEvent, calendarId, paramsIdentity?.userId, paramsIdentity?.sessionInstanceId, mode, eventId]);

  // drafts配列は、圧縮・アップロード等の非同期処理の合間に「このドラフトはまだ存在するか
  // （キャンセル・削除されていないか）」を都度確認するために参照する。useEffectでdrafts state
  // からrefへ同期する方式だと、React側のeffectフラッシュタイミングに依存してしまい、
  // 同じ非同期関数内で立て続けにawaitを挟む場合に確認が間に合わないことがある
  // （実際に競合を引き起こしたため、setDraftsSyncedで常に同期的に一致させる方式にした）。
  const draftsRef = useRef<AttachmentDraft[]>([]);
  const setDraftsSynced = useCallback((updater: (prev: AttachmentDraft[]) => AttachmentDraft[]) => {
    const next = updater(draftsRef.current);
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const lastCommitContextRef = useRef<CommitAttachmentsContext | null>(null);

  // editモードのみ既存の添付一覧を取得する。createモードはevents行がまだ無いため取得しない
  // （呼んでも常に空になるだけで、意味のある結果を返さない）。要求tokenで後発要求だけを反映する。
  const listGenerationRef = useRef(0);
  useEffect(() => {
    if (mode !== "edit") return;
    const scope = captureAttachmentScope();
    const gen = ++listGenerationRef.current;
    setLoading(true);
    const listPromise =
      scope.storage === "cloud" && scope.identity
        ? cloudAttachmentRepository.list(eventId, scope.identity)
        : scope.storage === "local"
          ? localAttachmentRepository.list(eventId)
          : Promise.resolve<EventAttachment[]>([]); // cloud-blocked: 取得しない
    listPromise
      .then((list) => {
        if (listGenerationRef.current !== gen || !isAttachmentScopeCurrent(scope)) return;
        setAttachments(list);
      })
      .catch((e) => {
        // DATA-F002-002: 端末内添付(getEventAttachments)は形状不正なトップレベルデータに
        // 対してthrowするようになったため、未処理のPromise拒否を防ぐためだけに明示的に
        // catchする（開発時のみログ）。失敗時は添付一覧を空のまま扱う（既存の初期値のまま）。
        if (listGenerationRef.current !== gen || !isAttachmentScopeCurrent(scope)) return;
        if (__DEV__) {
          console.warn("[useEventAttachments] 添付一覧の読み込みに失敗しました", e);
        }
      })
      .finally(() => {
        // Round14、P1-3: request-tokenだけでなくscope（generation+mounted、cloudならidentityの
        // 現在性）も確認してからのみsetLoadingする。
        if (listGenerationRef.current === gen && isAttachmentScopeCurrent(scope)) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captureAttachmentScope/isAttachmentScopeCurrentは安定参照。スコープ自体の変化はscopeRef.current.generationの更新（レンダーごとの同期）で検知する
  }, [mode, eventId, isCloudEvent, calendarId, paramsIdentity?.userId, paramsIdentity?.sessionInstanceId]);

  const updateDraft = useCallback(
    (id: string, patch: Partial<AttachmentDraft>) => {
      setDraftsSynced((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    },
    [setDraftsSynced]
  );

  /** editモード専用：選択直後に圧縮→正式repositoryへ即時登録する（既存フェーズ2の挙動を維持）。 */
  const runImmediateCreate = useCallback(
    async (draft: AttachmentDraft, scope: AttachmentOperationScope) => {
      // P0022（QA-F007 Batch3.2、7節）: 最初のdraft state更新（cloud-blocked分岐のものを
      // 含む）より前にscopeの現在性を確認する。retryAttachment自身が既に同じ確認をしているが、
      // 将来別のcallerが直接この関数を呼ぶ場合にも安全なよう、この関数自身も入口で防御する。
      if (!isAttachmentScopeCurrent(scope)) return;
      if (scope.storage === "cloud-blocked") {
        updateDraft(draft.id, { status: "draft-failed", errorReason: "upload-failed" });
        return;
      }
      const plan = effectivePlan;
      const limits = getAttachmentLimits(plan);
      try {
        updateDraft(draft.id, { status: "processing", errorReason: undefined });
        const processed = await processPickedImage(
          {
            uri: draft.sourceUri,
            mimeType: draft.sourceMimeType,
            width: draft.sourceWidth,
            height: draft.sourceHeight,
          },
          limits
        );
        if (!draftsRef.current.some((d) => d.id === draft.id)) return;
        if (!isAttachmentScopeCurrent(scope)) return;

        if (scope.storage === "local") {
          const currentTotal = await getLocalAttachmentsTotalBytes();
          // Round15、P1-3: draftsRef単体ではなくscopeの現在性も確認する（identity/eventId等が
          // 既に別のものというケースを逃さないため。runDraftProcessingと同じパターン）。
          if (!draftsRef.current.some((d) => d.id === draft.id) || !isAttachmentScopeCurrent(scope)) return;
          const check = canSaveProcessedImage(processed.byteSize, currentTotal, plan);
          if (!check.allowed) {
            updateDraft(draft.id, {
              status: "draft-failed",
              errorReason: check.reason === "image-too-large" ? "too-large-after-compression" : "total-quota",
            });
            return;
          }
        } else if (processed.byteSize > limits.maxBytesPerImage) {
          updateDraft(draft.id, { status: "draft-failed", errorReason: "too-large-after-compression" });
          return;
        } else if (quotaStatus && processed.byteSize > quotaStatus.remainingBytes) {
          // quotaStatus未取得時はここで判定できないため、最終判定は正式登録時の
          // enforce_attachment_quotaトリガーに委ねる（現状維持）。取得済みの場合のみ、
          // 無駄なアップロード試行を避けるためここで先に弾く。
          updateDraft(draft.id, { status: "draft-failed", errorReason: "total-quota" });
          return;
        }

        let saved: EventAttachment;
        if (scope.storage === "cloud") {
          if (!scope.calendarId || !scope.identity) {
            updateDraft(draft.id, { status: "draft-failed", errorReason: "upload-failed" });
            return;
          }
          saved = await cloudAttachmentRepository.create(processed, {
            id: draft.id,
            eventId,
            sortOrder: draft.sortOrder,
            calendarId: scope.calendarId,
            identity: scope.identity,
          });
        } else {
          saved = await localAttachmentRepository.create(processed, {
            id: draft.id,
            eventId,
            sortOrder: draft.sortOrder,
          });
        }

        // P0023（QA-F007 Batch3.3、6節）: cancellation判定（draftがまだ存在するか）を
        // stale UI gateより先に行う。以前はscopeのstale判定を先に行っていたため、
        // scope staleかつdraftが既に削除済みの場合に補償削除の分岐自体へ到達できず、
        // cloud側はC10でdurable化したdelete-intentの後続remote removeが一切試みられず、
        // local側もscope staleを理由に一切removeを試みず孤立ファイルが残っていた。
        if (!draftsRef.current.some((d) => d.id === draft.id)) {
          // ドラフト側で既にキャンセルされていた（removeAttachment経由。cloud editの場合、
          // removeAttachment内でC10により同じattachmentIdのdelete-intentが既にdurable化
          // 済みであることが前提）。
          if (scope.storage === "cloud") {
            // P0023（7節）: 削除意思は既にdurableで、owner側のretry
            // （retryPendingAttachmentCleanups）が削除を継続するため、ここでのremote
            // remove失敗（stale化を含む）を理由にUI stateへsavedを復元することはしない
            // （以前は全errorで復元していたが、それはhidden-but-untrackedを避けるための
            // 暫定策であり、durable intentが確立した今は不要かつ「visible-but-background
            // retryで突然消える」という別の混乱を招く）。scope staleならremote removeの
            // 開始自体を行わない（durable intentがownerの再試行に安全に委ねられる）。
            if (isAttachmentScopeCurrent(scope) && scope.identity && scope.calendarId) {
              await cloudAttachmentRepository
                .remove({ attachmentId: saved.id, eventId, calendarId: scope.calendarId, identity: scope.identity })
                .catch(() => {});
            }
          } else if (scope.storage === "local") {
            // ローカルはidentityに依存しないexact objectのため、scope stale/unmount後でも
            // 削除だけは試みる（永続的なlocal repositoryへ孤立して残さないため）。
            try {
              await localAttachmentRepository.remove(saved.id, eventId);
            } catch {
              if (isAttachmentScopeCurrent(scope)) {
                setAttachments((prev) => (prev.some((a) => a.id === saved.id) ? prev : [...prev, saved]));
                setLastError("delete-failed");
              }
              // scope staleならold React stateへは一切触れない。永続repositoryに残った
              // saved行は既存契約どおり再open時に見える。
            }
          }
          return;
        }
        if (!isAttachmentScopeCurrent(scope)) return;
        setAttachments((prev) => [...prev, saved]);
        setDraftsSynced((prev) => prev.filter((d) => d.id !== draft.id));
        refreshQuotaStatus();
      } catch (e) {
        // Round15、P1-3: mountedRef単体ではなくscopeの現在性も確認する（画面はremount済みで
        // マウント状態自体はtrueのまま、しかしidentity/eventId等が既に別のものというケースを
        // 逃さないため。runDraftProcessing/commitOneと同じパターン）。
        if (isCloudCreateStaleError(e) || !mountedRef.current || !isAttachmentScopeCurrent(scope)) return;
        const reason = e instanceof AttachmentProcessingError ? e.reason : mapServerError(e);
        updateDraft(draft.id, { status: "draft-failed", errorReason: reason });
      }
    },
    [effectivePlan, quotaStatus, eventId, updateDraft, setDraftsSynced, refreshQuotaStatus, isAttachmentScopeCurrent]
  );

  /**
   * createモード専用：選択直後は圧縮までしか行わず、ドラフト用ディレクトリへ保存するだけ。
   * Storage・event_attachments・端末内正式repositoryのいずれへも一切登録しない
   * （events行がまだ存在しないため）。ローカルファイル操作自体はidentityに依存しないが、
   * Round13、P1-3: スコープが変化した場合（identity/eventId/calendarId/storage種別の
   * いずれか）は、途中経過をstateへ反映せず、今回作成しかけたドラフトファイルだけを削除する
   * （画面はidentity変化により既にremountされているはずのため、古いHookインスタンス側の
   * 後始末という位置づけ）。
   */
  const runDraftProcessing = useCallback(
    async (draft: AttachmentDraft, scope: AttachmentOperationScope) => {
      // P0022（QA-F007 Batch3.2、7節）: runImmediateCreateと同じ理由で、cloud-blocked分岐を
      // 含む最初のdraft state更新より前にscopeの現在性を確認する。
      if (!isAttachmentScopeCurrent(scope)) return;
      if (scope.storage === "cloud-blocked") {
        // Round14、P1-3: retryAttachment経由でcloud-blocked中に再到達しうるため、
        // runImmediateCreate/commitOneと同様にここでも入口で明示的に拒否する
        // （ドラフトのローカルファイル操作自体はidentityに依存しないが、後段のコミットが
        // 前提とするスコープが確定していない状態で処理を進めないため）。
        updateDraft(draft.id, { status: "draft-failed", errorReason: "upload-failed" });
        return;
      }
      const plan = effectivePlan;
      const limits = getAttachmentLimits(plan);
      try {
        updateDraft(draft.id, { status: "processing", errorReason: undefined });
        const processed = await processPickedImage(
          {
            uri: draft.sourceUri,
            mimeType: draft.sourceMimeType,
            width: draft.sourceWidth,
            height: draft.sourceHeight,
          },
          limits
        );
        if (!draftsRef.current.some((d) => d.id === draft.id) || !isAttachmentScopeCurrent(scope)) return;

        if (scope.storage === "local") {
          const currentTotal = await getLocalAttachmentsTotalBytes();
          if (!draftsRef.current.some((d) => d.id === draft.id) || !isAttachmentScopeCurrent(scope)) return;
          const check = canSaveProcessedImage(processed.byteSize, currentTotal, plan);
          if (!check.allowed) {
            updateDraft(draft.id, {
              status: "draft-failed",
              errorReason: check.reason === "image-too-large" ? "too-large-after-compression" : "total-quota",
            });
            return;
          }
        } else if (processed.byteSize > limits.maxBytesPerImage) {
          updateDraft(draft.id, { status: "draft-failed", errorReason: "too-large-after-compression" });
          return;
        } else if (quotaStatus && processed.byteSize > quotaStatus.remainingBytes) {
          // quotaStatus未取得時（新規作成の初回描画直後など）はここで判定できないため、
          // 最終判定は正式コミット時のenforce_attachment_quotaトリガーに委ねる（現状維持）。
          updateDraft(draft.id, { status: "draft-failed", errorReason: "total-quota" });
          return;
        }

        const localDraftUri = await saveDraftAttachmentFile(draft.draftSessionId, draft.id, processed.localUri);
        if (!draftsRef.current.some((d) => d.id === draft.id) || !isAttachmentScopeCurrent(scope)) {
          await deleteDraftAttachmentFile(draft.draftSessionId, draft.id);
          return;
        }
        updateDraft(draft.id, {
          status: "draft-ready",
          localDraftUri,
          mimeType: processed.mimeType,
          byteSize: processed.byteSize,
          width: processed.width,
          height: processed.height,
        });
      } catch (e) {
        // Round14、P1-3: mountedRef単体ではなくscopeの現在性も確認する（画面はremount済みで
        // マウント状態自体はtrueのまま、しかしidentity/eventId等が既に別のものというケースを
        // 逃さないため）。
        if (!isAttachmentScopeCurrent(scope)) return;
        const reason = e instanceof AttachmentProcessingError ? e.reason : mapServerError(e);
        updateDraft(draft.id, { status: "draft-failed", errorReason: reason });
      }
    },
    [effectivePlan, quotaStatus, updateDraft, isAttachmentScopeCurrent]
  );

  /**
   * ドラフト1件を正式なrepositoryへ登録する（createモード、予定保存成功後にのみ呼ばれる）。
   * 同じdraft.id（=attachmentId）をそのまま冪等キーとして使うため、再試行しても重複登録されない。
   * identityがcreate()中にstale化した場合、またはcloud-blockedの場合は"stale"を返す
   * （"failed"へ畳み込まない）。
   */
  const commitOne = useCallback(
    async (draft: AttachmentDraft, scope: AttachmentOperationScope): Promise<"success" | "failed" | "stale"> => {
      // Round15、P1-3: scopeの確認をどのstate更新よりも先に行う（context欠落等の
      // 通常エラー状態への更新を、既にstaleなscopeに対して行ってしまわないため）。
      if (scope.storage === "cloud-blocked") return "stale";
      if (!isAttachmentScopeCurrent(scope)) return "stale";
      const context = lastCommitContextRef.current;
      if (
        !context ||
        !draft.localDraftUri ||
        !draft.mimeType ||
        draft.byteSize == null ||
        draft.width == null ||
        draft.height == null
      ) {
        updateDraft(draft.id, { status: "commit-failed", errorReason: "save-failed" });
        return "failed";
      }
      updateDraft(draft.id, { status: "committing", errorReason: undefined });
      try {
        const processed: ProcessedImage = {
          localUri: draft.localDraftUri,
          mimeType: draft.mimeType,
          byteSize: draft.byteSize,
          width: draft.width,
          height: draft.height,
        };
        let saved: EventAttachment;
        if (scope.storage === "cloud") {
          if (!context.calendarId || !scope.identity) {
            updateDraft(draft.id, { status: "commit-failed", errorReason: "save-failed" });
            return "failed";
          }
          saved = await cloudAttachmentRepository.create(processed, {
            id: draft.id,
            eventId: context.eventId,
            sortOrder: draft.sortOrder,
            calendarId: context.calendarId,
            identity: scope.identity,
          });
        } else {
          saved = await localAttachmentRepository.create(processed, {
            id: draft.id,
            eventId: context.eventId,
            sortOrder: draft.sortOrder,
          });
        }
        if (!isAttachmentScopeCurrent(scope)) return "stale";
        // [P0120 §6 adversarial sweep / ROBUST-POSTPRIMARY-001 同系] ここより上で添付の
        // 正式登録（cloud: Storage+DB行、local: メタデータ+ファイル）は既にdurableに確定して
        // いる。ドラフト一時ファイルの後始末は二次処理であり、その失敗（expo-file-systemの
        // file.delete()は実FSエラーでthrowする）を下のcatchで"commit-failed"へ畳み込むと、
        // 実際には登録済みの添付をユーザーへ「保存できませんでした」と伝えることになる。
        // [P0122 §8 訂正] 孤立したドラフト一時ファイルのdurable recovery権威は
        // `cleanupOrphanedAttachmentDrafts()`（src/services/attachmentDraftStorage.ts、
        // DATA-F002-003）である。AppDataContextの初期化（AppDataContext.tsx:1239）が
        // **アプリ起動ごとに必ず1回**、`attachments/drafts/`配下のセッションディレクトリを
        // 同期的に一括削除するため、ここでdeleteが失敗して残ったファイルも次回起動で回収される。
        // （P0120はこれを`retryPendingAttachmentCleanups`/`discardDraftAttachments`に
        // 帰属させていたが、前者は**クラウド側**Storage/DBのcleanup intent再試行であり
        // 端末内ドラフトには一切関与せず、後者は同一セッション内のユーザー明示キャンセル用で
        // コミット済み経路の孤立ファイル回収ではない。）
        // 既存recoveryで十分なため、新しいdurable journalは追加しない。
        await runPostPrimaryStep("添付の正式登録後のドラフト一時ファイル後始末", () =>
          deleteDraftAttachmentFile(draft.draftSessionId, draft.id)
        );
        if (!isAttachmentScopeCurrent(scope)) return "stale";
        setAttachments((prev) => [...prev, saved]);
        setDraftsSynced((prev) => prev.filter((d) => d.id !== draft.id));
        return "success";
      } catch (e) {
        // Round15、P1-3: mountedRef単体ではなくscopeの現在性も確認する。catch到達時点で
        // 既にstale化している場合は、通常の"commit-failed"へ畳み込まず"stale"として扱う
        // （呼び出し元runCommitDraftAttachmentsは"stale"を見て打ち切るため）。
        if (isCloudCreateStaleError(e) || !mountedRef.current || !isAttachmentScopeCurrent(scope)) return "stale";
        updateDraft(draft.id, { status: "commit-failed", errorReason: mapServerError(e) });
        return "failed";
      }
    },
    [updateDraft, setDraftsSynced, isAttachmentScopeCurrent]
  );

  // Round14、P1-3: 呼び出し中に別のcommitDraftAttachments呼出しが重ねて発火しても、
  // 同じ実行のPromiseへ合流させる（single-flight）。これにより、進行中のコミットが
  // 参照しているlastCommitContextRefを別の呼出しが横から書き換えてしまう競合を防ぐ。
  const commitInFlightRef = useRef<Promise<CommitResult> | null>(null);

  const runCommitDraftAttachments = useCallback(
    async (context: CommitAttachmentsContext): Promise<CommitResult> => {
      const scope = captureAttachmentScope();
      // Round14、P1-3: 呼び出し元が渡したcontext（保存直後のeventId/calendarId）が、
      // このHookインスタンスが捕捉している現在のscopeと一致しない場合は何もコミットしない
      // （Hookの使い回し・呼び出し元の取り違え等による誤ったcalendarId/eventIdへの
      // 登録を防ぐ、fail-closed）。
      if (context.eventId !== scope.eventId || (context.calendarId ?? null) !== scope.calendarId) {
        return { succeededCount: 0, failedCount: 0, stoppedDueToStaleIdentity: true };
      }
      lastCommitContextRef.current = context;
      const toCommit = draftsRef.current.filter(
        (d) => d.status === "draft-ready" || d.status === "commit-failed"
      );
      let succeededCount = 0;
      let failedCount = 0;
      for (const draft of toCommit) {
        if (!isAttachmentScopeCurrent(scope)) {
          return { succeededCount, failedCount, stoppedDueToStaleIdentity: true };
        }
        // eslint-disable-next-line no-await-in-loop -- sort_orderを保った順に、多くても数枚のため直列で十分
        const outcome = await commitOne(draft, scope);
        if (outcome === "success") succeededCount += 1;
        else if (outcome === "failed") failedCount += 1;
        else {
          // "stale": 打ち切る。残りの下書きはコミットせず、failedCountへも畳み込まない。
          return { succeededCount, failedCount, stoppedDueToStaleIdentity: true };
        }
      }
      if (succeededCount > 0 && isAttachmentScopeCurrent(scope)) {
        // コミット直後はevents行が実在するため（context.eventIdはフックのeventId
        // propと同じ値）、refreshQuotaStatus()でそのまま取り直せる。
        refreshQuotaStatus();
      }
      return { succeededCount, failedCount, stoppedDueToStaleIdentity: false };
    },
    [commitOne, refreshQuotaStatus, isAttachmentScopeCurrent, captureAttachmentScope]
  );

  const commitDraftAttachments = useCallback(
    async (context: CommitAttachmentsContext): Promise<CommitResult> => {
      if (mode !== "create") {
        return { succeededCount: 0, failedCount: 0, stoppedDueToStaleIdentity: false };
      }
      if (commitInFlightRef.current) return commitInFlightRef.current;
      const run = runCommitDraftAttachments(context).finally(() => {
        commitInFlightRef.current = null;
      });
      commitInFlightRef.current = run;
      return run;
    },
    [mode, runCommitDraftAttachments]
  );

  const addImage = useCallback(async () => {
    // P0023（QA-F007 Batch3.3、8節）: scopeの現在性確認を、setLastError(null)を含む
    // いかなるstate更新・副作用（NetInfo.fetch、ImagePicker権限確認・起動等）よりも
    // 先に行う。以前はsetLastError(null)が最初に実行されていたため、authSessionIdentityStore
    // 側は既にA→Bへ切り替わったがこのHookインスタンスがまだReact再レンダーを受けていない
    // 短い窓でaddImage()が呼ばれると、stale化したHookインスタンス側でstate更新・
    // NetInfo/ImagePicker呼出しが発生してしまっていた。
    const scope = captureAttachmentScope();
    if (!isAttachmentScopeCurrent(scope)) return;

    setLastError(null);
    if (scope.storage === "cloud-blocked") return; // remote/localどちらの保存も一切開始しない

    const plan = effectivePlan;
    const activeCount = attachments.length + drafts.filter((d) => d.status !== "draft-failed").length;
    const limitCheck = canAddMoreImages(activeCount, plan);
    if (!limitCheck.allowed) {
      setLastError("event-limit");
      return;
    }
    if (scope.storage === "cloud" && quotaStatus && !quotaStatus.canUpload) {
      // 枚数はまだ余っていても、総容量超過など枚数以外の理由でサーバーが追加を
      // 許可していない場合はここで弾く（get_attachment_quota_statusのcan_uploadを正本とする。
      // 権限起因の場合もこの経路に来るが、NormalEventForm側でviewerの共有カレンダーは
      // isCloudEvent=falseになる既存の選択肢制限があるため、実際にはほぼ総容量超過のみ）。
      setLastError("total-quota");
      return;
    }

    // createモードの画像追加は端末内ドラフト保存のみで完結し通信を伴わないため、
    // オフライン確認はeditモード（即時アップロード）でのみ行う。
    if (mode === "edit" && scope.storage === "cloud") {
      const net = await NetInfo.fetch();
      if (!isAttachmentScopeCurrent(scope)) return;
      if (!net.isConnected) {
        setLastError("offline");
        return;
      }
    }
    if (!isAttachmentScopeCurrent(scope)) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!isAttachmentScopeCurrent(scope)) return;
    if (!permission.granted) {
      setLastError("permission-denied");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsEditing: false,
    });
    if (!isAttachmentScopeCurrent(scope)) return;
    if (result.canceled || !result.assets || result.assets.length === 0) return;
    const asset = result.assets[0];

    const draft: AttachmentDraft = {
      id: Crypto.randomUUID(),
      draftSessionId: draftSessionId ?? eventId,
      sourceUri: asset.uri,
      sourceMimeType: asset.mimeType ?? "",
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      status: "processing",
      sortOrder: attachments.length + drafts.length,
    };
    setDraftsSynced((prev) => [...prev, draft]);
    if (mode === "edit") {
      await runImmediateCreate(draft, scope);
    } else {
      await runDraftProcessing(draft, scope);
    }
  }, [
    attachments,
    drafts,
    effectivePlan,
    quotaStatus,
    mode,
    eventId,
    draftSessionId,
    runImmediateCreate,
    runDraftProcessing,
    setDraftsSynced,
    captureAttachmentScope,
    isAttachmentScopeCurrent,
  ]);

  const retryAttachment = useCallback(
    async (id: string) => {
      const scope = captureAttachmentScope();
      // P0022（QA-F007 Batch3.2、7節）: captureAttachmentScope()直後、draft検索やdispatchより
      // 前にscopeの現在性を確認する。以前はmountedRef単体しか見ておらず、
      // authSessionIdentityStore側は既にA→Bへ切り替わったがこのHookインスタンスがまだ
      // React再レンダーを受けていない（generationRef/scopeRefが古いまま）短い窓で
      // retryAttachmentが呼ばれると、isAttachmentScopeCurrent（authSessionIdentityStoreを
      // 直接参照する）だけがこの窓を検知でき、そのままrunImmediateCreate/runDraftProcessingへ
      // 進んでしまうとdraft状態の書き換え・processPickedImage呼出しが発生してしまっていた。
      if (!isAttachmentScopeCurrent(scope)) return;
      // Round15、P1-3: cloud-blockedの場合はここで停止し、状態変更を一切行わない
      // （runImmediateCreate/runDraftProcessingへ委ねるとdraft-failedへ再更新してしまうため、
      // retry操作自体としては何もしなかったことにする）。
      if (scope.storage === "cloud-blocked") return;
      const draft = draftsRef.current.find((d) => d.id === id);
      if (!draft) return;
      if (mode === "edit") {
        await runImmediateCreate(draft, scope);
      } else if (draft.status === "commit-failed") {
        await commitOne(draft, scope);
      } else {
        await runDraftProcessing(draft, scope);
      }
    },
    [mode, runImmediateCreate, runDraftProcessing, commitOne, captureAttachmentScope, isAttachmentScopeCurrent]
  );

  const removeAttachment = useCallback(
    async (id: string) => {
      const scope = captureAttachmentScope();
      const draft = draftsRef.current.find((d) => d.id === id);
      if (draft) {
        // Round15、P1-3: ファイル削除より前にもscopeの現在性を確認する（既にstale化した
        // 呼び出しが、新しいHookインスタンス側のドラフトファイルを誤って削除しないため）。
        if (!isAttachmentScopeCurrent(scope)) return;

        // P0023（QA-F007 Batch3.3、3節）: edit-modeのcloud draftは選択直後にrunImmediateCreate
        // が即時remote createを開始している可能性があるため、draftをstateから消す前に、
        // 同じattachmentIdの削除意思をdurable storageへ記録する（根本不変条件、1節）。
        // これにより、createが後から遅れて成功しidentityが既にstale化していても、
        // cleanup ownershipを失わない（owner側のretryが安全に削除を継続できる）。
        // create-modeはremote createが未開始のため対象外、local editはcloud intent不要。
        if (mode === "edit" && scope.storage === "cloud" && scope.identity && scope.calendarId) {
          try {
            await queueCloudAttachmentDeleteIntent({
              attachmentId: draft.id,
              eventId,
              calendarId: scope.calendarId,
              ownerUserId: scope.identity.userId,
            });
          } catch {
            // queue失敗: draftをstateから消さない・local draft fileも先に消さない。
            // scope currentならlastError="delete-failed"を出し、ユーザーが同じdraftを
            // 再度削除できるようにする。remote/create側の副作用はこの削除操作からは
            // 一切開始しない。
            if (isAttachmentScopeCurrent(scope)) setLastError("delete-failed");
            return;
          }
          if (!isAttachmentScopeCurrent(scope)) {
            // queue成功後にscope stale: old UI stateは変更しない。intentは残したまま、
            // owner Aの再試行（retryPendingAttachmentCleanups）へ委ねる。
            return;
          }
        }

        // まだ正式登録されていないドラフトはローカルファイルを消してstateから外すだけでよい
        // （Storage/DBのどちらにも何も送っていないため、確認ダイアログも不要）。
        if (draft.localDraftUri) {
          await deleteDraftAttachmentFile(draft.draftSessionId, draft.id);
        }
        // Round14、P1-3: mountedRef単体ではなくscopeの現在性も確認してからstateを更新する。
        if (!isAttachmentScopeCurrent(scope)) return;
        setDraftsSynced((prev) => prev.filter((d) => d.id !== id));
        return;
      }
      // 正式登録済みの添付（EventAttachment）の削除
      if (!isAttachmentScopeCurrent(scope)) return;
      setDeletingIds((prev) => new Set(prev).add(id));
      try {
        if (scope.storage === "cloud") {
          if (!scope.identity || !scope.calendarId) throw new Error("cloud attachment removal requires identity");
          await cloudAttachmentRepository.remove({
            attachmentId: id,
            eventId,
            calendarId: scope.calendarId,
            identity: scope.identity,
          });
        } else if (scope.storage === "local") {
          await localAttachmentRepository.remove(id, eventId);
        } else {
          return; // cloud-blocked: 削除操作自体を開始しない
        }
        if (!isAttachmentScopeCurrent(scope)) return;
        setAttachments((prev) => prev.filter((a) => a.id !== id));
        refreshQuotaStatus();
      } catch (e) {
        // 途中断・stale化はCloudAttachmentRemoveStaleErrorとして届くため、通常のdelete-failedへは
        // 畳み込まない（UI側で汎用エラーとして誤解させないため）。
        // P0024（QA-F007 Batch3.4、12節）: mountedRef単体ではなくscopeの現在性も確認する。
        // 以前はgenerationの変化（local: eventId変更、cloud: 同一identityのままcalendarId
        // 変更）を見ておらず、古いHookインスタンスがmountedRef.current===trueのまま
        // 生存し続けているケースでlastError="delete-failed"を誤って設定してしまっていた。
        if (
          e instanceof CloudAttachmentRemoveStaleError ||
          !mountedRef.current ||
          !isAttachmentScopeCurrent(scope)
        ) {
          return;
        }
        setLastError("delete-failed");
      } finally {
        // Round13、P1-3: finallyでのdeletingIds更新もscopeが今も現在の場合のみ行う。
        if (isAttachmentScopeCurrent(scope)) {
          setDeletingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }
    },
    [mode, eventId, setDraftsSynced, refreshQuotaStatus, isAttachmentScopeCurrent, captureAttachmentScope]
  );

  const discardDraftAttachments = useCallback(async () => {
    if (mode !== "create") return;
    // Round15、P1-3: セッションディレクトリ全体をdeleteDraftSession()で無条件に削除すると、
    // 破棄処理の実行中に別スコープ（新しいHookインスタンス）が同じdraftSessionIdへ
    // 新規ファイルを書き込んだ場合、それも巻き込んで削除してしまう恐れがある。
    // 呼び出し開始時点で存在する下書きIDだけをスナップショットし、個別に削除することで
    // この巻き込みを避ける（未知の新規ファイルには一切触れない）。
    // ローカルファイルの削除自体（identityに依存しない端末内操作）は常に実行するが、
    // stateの更新（setDraftsSynced）はその非同期処理が終わった時点でもscopeが
    // 現在のものである場合のみ行う。
    //
    // P0021（C11、invariant D）: 各下書きファイルの実際の保存先は、その下書き自身が
    // 生成された時点で捕捉したdraft.draftSessionId（他の全操作——runDraftProcessing/
    // commitOne/removeAttachment等——と同じ規約）であり、このコールバックが呼ばれた
    // 時点のライブなdraftSessionId引数ではない（以前はここだけ後者を全下書きへ
    // 一律適用しており、operation scopeを開始時に固定するという規約から外れていた）。
    const scope = captureAttachmentScope();
    const targets = draftsRef.current.map((d) => ({ id: d.id, draftSessionId: d.draftSessionId }));
    await Promise.all(
      targets.map((t) => Promise.resolve(deleteDraftAttachmentFile(t.draftSessionId, t.id)).catch(() => {}))
    );
    if (!isAttachmentScopeCurrent(scope)) return;
    setDraftsSynced(() => []);
  }, [mode, setDraftsSynced, captureAttachmentScope, isAttachmentScopeCurrent]);

  const activeCountForLimits = attachments.length + drafts.filter((d) => d.status !== "draft-failed").length;
  const cloudMaxImages = quotaStatus
    ? quotaStatus.canUpload
      ? quotaStatus.maxFilesPerEvent
      : Math.min(quotaStatus.maxFilesPerEvent, activeCountForLimits)
    : getAttachmentLimits("free").maxImagesPerEvent;

  return {
    attachments,
    drafts,
    deletingIds,
    loading,
    limits: {
      // クラウドは所有者の実プラン(get_attachment_quota_status)由来。canUpload=falseの
      // 場合（総容量超過等）は現在数までにクランプし、追加ボタンを実質非表示にする
      // （EventAttachmentSection側のcanAddMore = activeCount < maxImagesPerEventがそのまま働く）。
      // ローカルは既存どおりdevicePlanに従う（今回のFP-004の対象外）。cloud-blockedもfree相当。
      maxImagesPerEvent: isCloudEvent ? cloudMaxImages : getAttachmentLimits(devicePlan).maxImagesPerEvent,
      plan: effectivePlan,
    },
    addImage,
    retryAttachment,
    removeAttachment,
    commitDraftAttachments,
    discardDraftAttachments,
    lastError,
    clearLastError: () => setLastError(null),
  };
}
