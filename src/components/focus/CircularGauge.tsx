import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors } from "@/theme/colors";

interface Props {
  size?: number;
  strokeWidth?: number;
  /** 0..1（経過率）。負の値・1超は内部でクランプする */
  progress: number;
  /** 残り時間の大表示（例: "59:42"） */
  primaryText: string;
  /** 予定時間全体の補助表示（例: "/ 60:00"） */
  secondaryText?: string;
}

/**
 * 円形の残り時間ゲージ。react-native-svgのCircle（strokeDasharray/strokeDashoffset）で
 * リングの進捗を表現し、中央にはRN標準のTextを絶対配置で重ねる（SVG内テキストは使わない）。
 * 色は常時ブランドブルー固定とし、残り時間が少なくなっても変化させない
 * （「過度に不安をあおる赤色演出にはしない」という要件を、色を変えないことで確実に満たす）。
 */
export function CircularGauge({
  size = 220,
  strokeWidth = 14,
  progress,
  primaryText,
  secondaryText,
}: Props) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const dashOffset = circumference * (1 - clampedProgress);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={colors.primarySoft}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={colors.primary}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          // 12時位置から時計回りに減っていくよう、中心を軸に-90度回転させる
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      <View style={styles.labelWrap} pointerEvents="none">
        <Text style={styles.primaryText}>{primaryText}</Text>
        {secondaryText ? <Text style={styles.secondaryText}>{secondaryText}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center" },
  labelWrap: { position: "absolute", alignItems: "center" },
  primaryText: {
    fontSize: 44,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: 1,
  },
  secondaryText: {
    marginTop: 4,
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: "600",
  },
});
