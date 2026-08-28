import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { ErrorBoundaryProps } from "expo-router";
import { PrimaryButton } from "@/components/common/PrimaryButton";
import { colors } from "@/theme/colors";
import { spacing } from "@/theme/spacing";
import { t } from "@/i18n/translations";

/**
 * 単独修正(2026-08、ROBUST-F001-001): ルートProvider・画面ツリーで発生した想定外の
 * React描画例外を全ルート共通で拾うフォールバック画面。
 *
 * app/_layout.tsxが名前付きexport`ErrorBoundary`としてこのコンポーネントを公開すると、
 * Expo Router自身（node_modules/expo-router/build/useScreens.jsのfromImport、
 * node_modules/expo-router/build/global-state/router-store.jsのrootComponent算出）が
 * ルートレイアウトのdefault export全体（＝GestureHandlerRootView〜Stackまでの
 * Providerツリー全体）を、実体が通常のReactクラス型Error Boundaryである
 * `Try`（node_modules/expo-router/build/views/Try.js）で自動的に包む。
 * そのため、ここでは独自のクラス型Boundaryを実装しない
 * （Expo Router標準機構と無意味に二重化させないため）。`Try`は各Providerより
 * 外側の祖先として存在するので、Provider自身の描画例外も含めて捕捉できる。
 *
 * 捕捉できないもの（Reactのエラー境界の原理上の制約であり、ここでは対応しない）:
 * イベントハンドラ内の例外、setTimeout等のタイマー内の例外、非同期Promiseの
 * 未処理rejection、useEffect内の非同期例外、ネイティブクラッシュ、Boundary自身の例外。
 * AppData自体の非同期初期化失敗（seed/refresh失敗）は対象外
 * （src/components/common/AppDataInitializationGate.tsxが引き続き専任で扱う。
 * ROBUST-F001-002を参照。ここでは変更・代替しない）。
 *
 * このコンポーネント自身はLocaleContext・AuthContext・
 * AppDataContext・HolidayRegionContextのいずれにも依存しない
 * （これらのProvider自体が例外の原因である可能性があるため、フォールバック表示は
 * それらが一切利用できない状態でも成立する必要がある）。文言は`useLocale()`ではなく
 * Provider非依存の`t()`（端末ロケールのみに基づく非リアクティブな翻訳、
 * src/i18n/translations.ts）を使う。
 *
 * 再試行（retry）はExpo Routerの`Try.retry()`をそのまま呼ぶだけでよい。
 * `Try.retry()`は内部的に`this.setState({ error: undefined })`をするだけだが、
 * Reactのエラー境界の仕様上、例外を捕捉した時点で古い子ツリー（Providerツリー全体）は
 * 既にアンマウント済みのため、retry後に`children`が再度描画される際は必ず新規の
 * マウントになる（＝Providerツリー全体が新規に作り直される）。よってkeyを使った
 * 独自の再マウント処理は不要。
 *
 * 再試行ボタンの連打対策として、retry()実行中はボタンを無効化する
 * （retry()が解決する前に再度呼ばれることを防ぐ）。ただし、retry()の解決後に
 * 同一の例外が再発した場合はExpo Router側で本コンポーネントの新しいインスタンスが
 * マウントされる（前のインスタンスはアンマウントされる）ため、内部状態のリセットは
 * 特別な処理をしなくても自然に行われる。
 */
export function RootErrorBoundaryFallback({ error, retry }: ErrorBoundaryProps) {
  const mountedRef = useRef(true);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // __DEV__時のみ、開発者調査用に最小限の情報だけを出す。
    // イベント内容・メールアドレス・認証トークン・AsyncStorage生データ・
    // 共有招待トークン・画像URL・環境変数の値は一切含めない。
    if (__DEV__) {
      // eslint-disable-next-line no-console -- 開発時のみのルート例外調査用ログ
      console.warn(
        "[RootErrorBoundaryFallback] ルートで想定外の描画例外を捕捉しました:",
        error.name,
        error.message
      );
    }
  }, [error]);

  const handleRetry = useCallback(() => {
    if (isRetrying) return;
    setIsRetrying(true);
    retry()
      .catch(() => {
        // Expo Router実装のTry.retry()は本来rejectしない（node_modules/expo-router/build/views/Try.js
        // 参照）が、ErrorBoundaryProps上の型はPromise<void>であり将来の実装変更にも備え、
        // 万一rejectしてもボタンを再度押せる状態へ戻すためだけに捕捉する。
      })
      .finally(() => {
        if (mountedRef.current) setIsRetrying(false);
      });
  }, [isRetrying, retry]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.warning} />
        <Text style={styles.title} accessibilityRole="header">
          {t("rootErrorBoundary.title")}
        </Text>
        <Text style={styles.message}>{t("rootErrorBoundary.message")}</Text>
        <PrimaryButton
          label={t("rootErrorBoundary.retryButton")}
          onPress={handleRetry}
          loading={isRetrying}
          accessibilityLabel={t("rootErrorBoundary.retryButton")}
          style={styles.retryButton}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  message: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  retryButton: { alignSelf: "stretch", marginTop: spacing.sm },
});
