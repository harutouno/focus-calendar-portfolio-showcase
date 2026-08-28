import React from "react";
import { Image, ImageStyle, StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";
import { colors } from "@/theme/colors";

interface Props {
  /** 画像URL。未設定・空文字なら頭文字Avatarにフォールバックする */
  uri?: string;
  /** 頭文字を取り出すための表示名(例: 表示名やメールアドレス) */
  label: string;
  /** 直径(px)。デフォルト32 */
  size?: number;
  /** 画像が無いときの背景色。デフォルトはテーマのprimarySoft */
  backgroundColor?: string;
  /** 画像が無いときの文字色。デフォルトはテーマのprimaryStrong */
  textColor?: string;
  style?: StyleProp<ViewStyle>;
}

function initialOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

/**
 * 一覧・詳細・設定・予定一覧で共通利用するアバター表示。
 * uriがあれば画像、なければテーマカラーの頭文字Avatarにフォールバックする。
 */
export function Avatar({
  uri,
  label,
  size = 32,
  backgroundColor = colors.primarySoft,
  textColor = colors.primaryStrong,
  style,
}: Props) {
  const dimensionStyle = { width: size, height: size, borderRadius: size / 2 };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, dimensionStyle, style] as StyleProp<ImageStyle>}
        accessibilityLabel={label}
      />
    );
  }

  return (
    <View
      style={[styles.fallback, dimensionStyle, { backgroundColor }, style]}
      accessibilityLabel={label}
    >
      <Text style={[styles.fallbackText, { color: textColor, fontSize: size * 0.42 }]}>
        {initialOf(label)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: colors.surfaceAlt,
  },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  fallbackText: {
    fontWeight: "700",
  },
});
