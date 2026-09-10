import React, { useEffect, useState } from "react";
import { Image, ImageStyle, StyleProp, StyleSheet, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { DefaultCalendarCover } from "./DefaultCalendarCover";

interface Props {
  /** 画像URL。未設定・空文字ならDefaultCalendarCoverにフォールバックする */
  uri?: string;
  /** フォールバック時のテーマカラー */
  color: string;
  /** フォールバック時のアイコン（DefaultCalendarCoverへそのまま渡す） */
  icon?: keyof typeof Ionicons.glyphMap;
  /** フォールバック時のアイコンサイズ（DefaultCalendarCoverへそのまま渡す） */
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * カレンダーのカバー表示。uriがあれば画像、なければDefaultCalendarCoverを表示する。
 * Storage/DB未設定（uriが常にundefined）でも壊れず、そのままDefaultCalendarCoverになる。
 * 画像の読み込みに失敗した場合（壊れたURL・削除済みのローカルファイル等）も、
 * 画面全体を崩さずDefaultCalendarCoverへ切り替える。
 */
export function CoverImage({ uri, color, icon, iconSize, style }: Props) {
  const [failed, setFailed] = useState(false);

  // uriが変わったら（画像を変更した場合等）、前回の失敗状態を引きずらない。
  useEffect(() => {
    setFailed(false);
  }, [uri]);

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, style] as StyleProp<ImageStyle>}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return <DefaultCalendarCover color={color} icon={icon} iconSize={iconSize} style={style} />;
}

const styles = StyleSheet.create({
  image: {
    flex: 1,
  },
});
