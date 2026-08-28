import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface Props {
  /** カレンダーのテーマカラー。グラデーションの基調色に使う */
  color: string;
  /** 中央に重ねるアイコン。デフォルトは"calendar"（一覧のカレンダー種別アイコンに使う場合に上書き可能） */
  icon?: keyof typeof Ionicons.glyphMap;
  /** アイコンのサイズ。デフォルト56（一覧の小さいサムネイルでは小さめの値を渡す） */
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * カレンダー全体で使う既定カバー。
 * テーマカラーの淡いグラデーション、薄い格子模様、白いアイコンで構成する。
 */
export function DefaultCalendarCover({ color, icon = "calendar", iconSize = 56, style }: Props) {
  return (
    <View style={[styles.container, { backgroundColor: color }, style]}>
      <View style={styles.gradientLight} pointerEvents="none" />
      <View style={styles.gradientDark} pointerEvents="none" />
      <View style={styles.gridPattern} pointerEvents="none">
        {[20, 40, 60, 80].map((percent) => (
          <View key={`h-${percent}`} style={[styles.gridLineH, { top: `${percent}%` }]} />
        ))}
        {[20, 40, 60, 80].map((percent) => (
          <View key={`v-${percent}`} style={[styles.gridLineV, { left: `${percent}%` }]} />
        ))}
      </View>
      <Ionicons
        name={icon}
        size={iconSize}
        color="rgba(255,255,255,0.45)"
        style={styles.icon}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  gradientLight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "55%",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  gradientDark: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "45%",
    backgroundColor: "rgba(0,0,0,0.10)",
  },
  gridPattern: {
    ...StyleSheet.absoluteFillObject,
  },
  gridLineH: {
    position: "absolute",
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  gridLineV: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  icon: {
    zIndex: 1,
  },
});
