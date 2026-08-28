import { OverlaySettings } from "@/types/event";

/**
 * 2026-08: マイカレンダー画面の「表示する予定」3択＋「すべて非表示」を、既存の
 * OverlaySettings.showNormalEvents/showTasksの組み合わせとして表す純粋関数。
 * 新しいstate・保存キーは一切持たず、既存の表示設定（app/overlay.tsx）と完全に同じ
 * 正本（overlaySettings）を読み書きするためだけに使う。
 *
 * - eventsOnly（通常のみ）: showNormalEvents=true, showTasks=false
 * - both（両方）        : showNormalEvents=true, showTasks=true
 * - focusOnly（集中のみ）: showNormalEvents=false, showTasks=true
 * - hideAll（すべて非表示）: showNormalEvents=false, showTasks=false
 *   （既存の表示設定画面では元々このOFF/OFF状態が可能だったため、既存ユーザーの
 *   この状態を勝手に別の状態へ書き換えないよう、3択とは別の追加選択肢として扱う）
 */
export type EventDisplayMode = "eventsOnly" | "both" | "focusOnly" | "hideAll";

export function eventDisplayModeFromOverlay(
  overlay: Pick<OverlaySettings, "showNormalEvents" | "showTasks">
): EventDisplayMode {
  if (overlay.showNormalEvents && overlay.showTasks) return "both";
  if (overlay.showNormalEvents && !overlay.showTasks) return "eventsOnly";
  if (!overlay.showNormalEvents && overlay.showTasks) return "focusOnly";
  return "hideAll";
}

export function applyEventDisplayMode(
  overlay: OverlaySettings,
  mode: EventDisplayMode
): OverlaySettings {
  switch (mode) {
    case "eventsOnly":
      return { ...overlay, showNormalEvents: true, showTasks: false };
    case "both":
      return { ...overlay, showNormalEvents: true, showTasks: true };
    case "focusOnly":
      return { ...overlay, showNormalEvents: false, showTasks: true };
    case "hideAll":
      return { ...overlay, showNormalEvents: false, showTasks: false };
  }
}
