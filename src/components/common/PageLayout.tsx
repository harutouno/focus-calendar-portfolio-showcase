import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";

interface Props {
  /** 画面ヘッダー（ScreenHeader・CalendarHeader等）。スクロールせず常に最上部に固定される。 */
  header?: React.ReactNode;
  /**
   * 画面本体（ScrollView等）。この外側をflex:1のViewで包むため、内容が短くても
   * 【重要】childrenの最上位要素がScrollViewの場合、その`style`にも`flex: 1`を
   * 指定すること（`contentContainerStyle`とは別）。指定が無いとScrollView自身は
   * 広がっても、ScrollViewがそこまで伸びずに下へ空白が残ってしまう
   * （RNのScrollViewは既定でflexが無いと親の残り領域を自動では埋めないため）。
   */
  children: React.ReactNode;
  /**
   * タブ形式のナビゲーション）。通常は不要で、ほとんどの画面では指定しない。
   */
  footer?: React.ReactNode;
  /** contentを包むView（flex:1）へ追加するスタイル。通常は不要。 */
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * （2026-07: メインカレンダー画面（app/index.tsx）専用。ヘッダー直下に
   * 従来通りこの共通位置のままにし、アプリ全体での位置統一は維持する）。
   */
}

/**
 * コンポーネント経由で表示する。
 *
 * 設計上のポイント:
 *   一緒に流れない。
 * - childrenをflex:1のViewで包むため、本体の内容がどれだけ短くても
 *   何も描画しない（return null）ため、その分だけchildrenの領域が自動的に広がる。
 *   持つ画面（app/index.tsx）だけが使う想定で、それ以外の画面では指定不要。
 *
 * SafeAreaViewはこのコンポーネントの外側（呼び出し元）で従来通り個別に指定する
 * （画面ごとに異なるedges設定を維持するため、ここでは強制しない）。
 */
export function PageLayout({ header, children, footer, contentStyle }: Props) {
  return (
    <>
      {header}
      <View style={[styles.content, contentStyle]}>{children}</View>
      {footer}
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
});
