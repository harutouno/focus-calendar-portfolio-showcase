import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getDeviceLocale, SupportedLocale, TranslationKey, translate } from "@/i18n/translations";
import { getServices } from "@/services/registry";
import { LoadingView } from "@/components/common/LoadingView";

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * アプリ全体の表示言語（ja/en）を保持するContext。AuthProvider/AppDataProviderと同列の
 * 横断的関心事として、app/_layout.tsxの最も外側に配置する。
 * 初期値は端末ロケールの同期判定（初回描画で誤った言語がちらつくのを避けるため）にし、
 * マウント後にlocaleService（保存済みの値があればそれを優先）で確定させる。
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [locale, setLocaleState] = useState<SupportedLocale>(() => getDeviceLocale());

  useEffect(() => {
    let mounted = true;
    getServices()
      .localeService.getInitialLocale()
      .then((initial) => {
        if (!mounted) return;
        setLocaleState(initial);
        setStatus("ready");
      })
      .catch(() => {
        if (!mounted) return;
        setLocaleState(getDeviceLocale());
        setStatus("ready");
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setLocale = useCallback((next: SupportedLocale) => {
    setLocaleState(next);
    // 保存に失敗しても表示言語自体は既に切り替えている（アプリを使う上でブロックしない）。
    // 未処理のPromise拒否を防ぐためだけに明示的にcatchする（開発時のみログ）。
    // 次回起動時はgetInitialLocaleが端末ロケールへ安全にフォールバックする既存挙動は変えない。
    getServices()
      .localeService.setLocale(next)
      .catch((e) => {
        if (__DEV__) {
          console.warn("[LocaleContext] setLocale の保存に失敗しました", e);
        }
      });
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  if (status === "loading") {
    return <LoadingView />;
  }

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}
