import { SupportedLocale } from "@/i18n/translations";

/**
 * アプリの表示言語（ja/en）の取得・保存を抽象化する。
 * 実装を差し替える場合（例: 将来サーバー同期する等）も、呼び出し側（LocaleContext）は
 * このインターフェースだけに依存する。
 */
export interface LocaleService {
  /**
   * 起動時に使うべきロケールを返す。保存済みの値があればそれを返し、
   * 無ければ端末ロケールを判定し、その結果をその場で保存してから返す
   * （「初回のみ端末言語判定、以後はユーザー設定を優先」を満たすための挙動。
   * 判定結果を初回に確定させることで、後で端末の言語設定が変わっても
   * アプリ内の言語は変わらない）。
   */
  getInitialLocale(): Promise<SupportedLocale>;
  /** ユーザーが明示的に選択したロケールを保存する。 */
  setLocale(locale: SupportedLocale): Promise<void>;
}
