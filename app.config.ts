import { ExpoConfig } from "expo/config";

/**
 * app.jsonから動的設定(app.config.ts)へ移行した（2026-08-XX、Google/Appleログイン追加のため）。
 * Googleのネイティブサインイン（iOS）が使うURL Schemeは、iOS OAuthクライアントIDから
 * 導出する必要があり、静的JSONでは環境変数を参照できないため。
 *
 * GoogleのiOS URL Schemeは「iOS OAuthクライアントID（例:
 * 1234567890-abcdefg.apps.googleusercontent.com）」のプレフィックス部分を使い、
 * "com.googleusercontent.apps.<プレフィックス>" という形式になる（Google公式仕様）。
 * EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID が未設定の間はundefinedのままにし、
 * 架空の値は入れない（iOS向けDev Buildをビルドする前に必ず設定が必要）。
 */
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const googleIosUrlScheme = googleIosClientId
  ? `com.googleusercontent.apps.${googleIosClientId.split(".")[0]}`
  : undefined;

/**
 * @react-native-google-signin/google-signin のconfigプラグインは、iosUrlSchemeが
 * 空でも呼び出されると即座に例外を投げる仕様（`expo config`/`expo-doctor`/`expo export`
 * 全てが失敗する）。EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID未設定の間はプラグイン自体を
 * plugins配列に含めないことで、既存のビルド・開発ワークフローを壊さないようにする
 * （架空の値を入れる代わりにこの方法を採る）。値が設定され次第、次回のconfig評価から
 * 自動的にプラグインが有効になる。
 */

const expoConfig: ExpoConfig = {
  name: "Focus Calendar",
  slug: "focus-calendar-app",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  scheme: "focuscalendar",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: false,
    bundleIdentifier: "com.haruto.focuscalendarapp",
    buildNumber: "1",
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    package: "com.haruto.focuscalendarapp",
    versionCode: 1,
  },
  web: {
    favicon: "./assets/favicon.png",
    bundler: "metro",
  },
  plugins: [
    "expo-router",
    "expo-notifications",
    "expo-font",
    "expo-localization",
    // Sign in with Apple（iOSネイティブ）のentitlementを自動付与するプラグイン。
    // パラメータは不要（Bundle ID自体がAppleへのClient IDとして機能するため）。
    "expo-apple-authentication",
    // Googleネイティブサインイン。このプラグインはiosUrlSchemeが空だと
    // config評価そのものが例外で失敗する仕様のため、EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
    // が未設定の間はplugins配列にこのエントリ自体を含めない
    // （架空の値を入れる代わりの回避策。値が設定され次第、次回のconfig評価から
    // 自動的にプラグインが有効になる）。
    ...(googleIosUrlScheme
      ? [
          [
            "@react-native-google-signin/google-signin",
            { iosUrlScheme: googleIosUrlScheme },
          ] as [string, Record<string, unknown>],
        ]
      : []),
  ],
  extra: {
    router: {
      origin: false,
    },
  },
};

export default { expo: expoConfig };
