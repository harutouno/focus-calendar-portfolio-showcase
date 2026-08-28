import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme/colors";

interface Props {
  top: number;
  label: string;
  showLabel?: boolean;
}

/** 現在時刻を示す赤い横線（週表示・日表示で使用） */
export function CurrentTimeLine({ top, label, showLabel = true }: Props) {
  return (
    <View style={[styles.container, { top }]} pointerEvents="none">
      {showLabel && <Text style={styles.label}>{label}</Text>}
      <View style={styles.dot} />
      <View style={styles.line} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 10,
  },
  label: {
    fontSize: 10,
    color: colors.warning,
    fontWeight: "700",
    width: 40,
    textAlign: "right",
    marginRight: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.warning,
    marginRight: -3,
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: colors.warning,
  },
});
