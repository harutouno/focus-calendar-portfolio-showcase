import React from "react";
import { FlatList, ListRenderItem, StyleProp, StyleSheet, ViewStyle } from "react-native";
import { FocusSessionRecord } from "@/types/event";
import { FocusHistoryListItem } from "./FocusHistoryListItem";

interface Props {
  records: FocusSessionRecord[];
  ListHeaderComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  ListFooterComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  ListEmptyComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  style?: StyleProp<ViewStyle>;
}

const keyExtractor = (record: FocusSessionRecord): string => record.id;

const renderItem: ListRenderItem<FocusSessionRecord> = ({ item }) => (
  <FocusHistoryListItem record={item} />
);

/**
 * 集中記録・分析画面のメインスクロール本体（仕様20番: 大きな履歴は必ずFlatList等で仮想化する）。
 * 画面全体を1本のScrollViewにせず、この1本のFlatListをメインスクロールにして、
 * ヘッダー（サマリー・グラフ等）とフッター（プレミアム詳細分析）をListHeader/ListFooterへ渡す。
 */
export function FocusHistoryList({
  records,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  style,
}: Props) {
  return (
    <FlatList
      style={[styles.list, style]}
      data={records}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={ListFooterComponent}
      ListEmptyComponent={ListEmptyComponent}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
});
