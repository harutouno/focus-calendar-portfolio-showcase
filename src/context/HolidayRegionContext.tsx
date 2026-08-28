import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { HolidayRegion } from "@/types/holidayRegion";
import { getServices } from "@/services/registry";
import { detectSupportedRegionFromDevice } from "@/services/deviceHolidayRegionService";
import { LoadingView } from "@/components/common/LoadingView";

interface HolidayRegionContextValue {
  region: HolidayRegion;
  setRegion: (region: HolidayRegion) => void;
}

const HolidayRegionContext = createContext<HolidayRegionContextValue | null>(null);

/**
 * 祝日の国・地域の状態管理。LocaleContext.tsxと同じ設計（Provider+useX()フック、
 * 保存済みの値が確定するまでchildrenをマウントしないゲート、mountedガードで
 * アンマウント後のsetStateを防ぐ）。表示言語（LocaleContext）とは完全に独立した
 * Providerとして扱う（言語の変更だけでは地域は変わらない）。
 */
export function HolidayRegionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [region, setRegionState] = useState<HolidayRegion>(() =>
    detectSupportedRegionFromDevice()
  );

  useEffect(() => {
    let mounted = true;
    getServices()
      .holidayRegionService.getInitialHolidayRegion()
      .then((initial) => {
        if (!mounted) return;
        setRegionState(initial);
        setStatus("ready");
      })
      .catch(() => {
        if (!mounted) return;
        setRegionState(detectSupportedRegionFromDevice());
        setStatus("ready");
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setRegion = useCallback((next: HolidayRegion) => {
    setRegionState(next);
    // 保存に失敗しても表示上の地域切替自体は既に反映済み（アプリを使う上でブロックしない）。
    // 未処理のPromise拒否を防ぐためだけに明示的にcatchする（開発時のみログ）。
    getServices()
      .holidayRegionService.setHolidayRegion(next)
      .catch((e) => {
        if (__DEV__) {
          console.warn("[HolidayRegionContext] setRegion の保存に失敗しました", e);
        }
      });
  }, []);

  const value = useMemo(() => ({ region, setRegion }), [region, setRegion]);

  if (status === "loading") {
    return <LoadingView />;
  }

  return (
    <HolidayRegionContext.Provider value={value}>{children}</HolidayRegionContext.Provider>
  );
}

export function useHolidayRegion(): HolidayRegionContextValue {
  const ctx = useContext(HolidayRegionContext);
  if (!ctx) {
    throw new Error("useHolidayRegion は HolidayRegionProvider の内側で使ってください");
  }
  return ctx;
}
