import React, { useEffect, useRef } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { useLocale } from "@/context/LocaleContext";
import { parseLocalDateString } from "@/utils/date";

/**
 * 年月ジャンプピッカー（正本§12 QA-F012）。元々app/index.tsxに直接書かれていたコンポーネントを
 * そのまま抽出したもので、挙動は一切変更していない。単体テスト（__tests__/yearMonthPicker.test.tsx）
 * から`app/index.tsx`全体（expo-router/expo-notifications/@expo/vector-icons等、重い依存を
 * 大量に持つ）を経由せずに直接importできるようにするための移動。
 */
export function YearMonthPicker({
  visible,
  focusedDate,
  onClose,
  onChoose,
}: {
  visible: boolean;
  focusedDate: string;
  onClose: () => void;
  onChoose: (year: number, month: number) => void;
}) {
  const { t, locale } = useLocale();
  const selected = parseLocalDateString(focusedDate);
  const years = Array.from({ length: 121 }, (_, i) => selected.getFullYear() - 60 + i);
  const scrollRef = useRef<ScrollView>(null);
  const selectedYearY = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, selectedYearY.current - 18), animated: false }), 100);
    return () => clearTimeout(timer);
  }, [visible]);
  const monthLabel = (m: number) => (locale === "ja" ? `${m + 1}月` : `${m + 1}`);
  const yearLabel = (year: number) => (locale === "ja" ? `${year}年` : `${year}`);
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.modalBackdrop} onPress={onClose}><Pressable style={styles.pickerCard} onPress={() => {}}>
      <Text style={styles.pickerTitle}>{t("yearMonthPicker.title")}</Text>
      <ScrollView ref={scrollRef} style={styles.yearScroll} contentContainerStyle={styles.yearGrid}>
        {years.map((year) => <View key={year} onLayout={(e) => { if (year === selected.getFullYear()) selectedYearY.current = e.nativeEvent.layout.y; }} style={styles.yearBlock}><Text style={styles.yearText}>{yearLabel(year)}</Text><View style={styles.monthGrid}>{Array.from({ length: 12 }, (_, m) => <Pressable key={m} style={[styles.monthButton, year === selected.getFullYear() && m === selected.getMonth() && styles.monthSelected]} onPress={() => onChoose(year, m)}><Text style={[styles.monthText, year === selected.getFullYear() && m === selected.getMonth() && styles.monthTextSelected]}>{monthLabel(m)}</Text></Pressable>)}</View></View>)}
      </ScrollView>
      <View style={styles.pickerActions}><Pressable style={styles.todayButton} onPress={() => { const now = new Date(); onChoose(now.getFullYear(), now.getMonth()); }}><Text style={styles.todayText}>{t("yearMonthPicker.backToThisMonth")}</Text></Pressable><Pressable style={styles.closeButton} onPress={onClose}><Text style={styles.closeText}>{t("yearMonthPicker.close")}</Text></Pressable></View>
    </Pressable></Pressable>
  </Modal>;
}

const styles = StyleSheet.create({
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 24 },
  pickerCard: { maxHeight: "82%", backgroundColor: colors.surface, borderRadius: 20, padding: 16 },
  pickerTitle: { fontSize: 20, fontWeight: "800", color: colors.textPrimary, marginBottom: 12 },
  yearScroll: { flexGrow: 0 },
  yearGrid: { paddingBottom: 12 },
  yearBlock: { marginBottom: 18 },
  yearText: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, marginBottom: 8 },
  monthGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  monthButton: { width: "23%", paddingVertical: 10, alignItems: "center", borderRadius: 10, backgroundColor: colors.surfaceAlt },
  monthSelected: { backgroundColor: colors.primary },
  monthText: { color: colors.textPrimary, fontWeight: "600" },
  monthTextSelected: { color: colors.textInverse },
  closeButton: { alignSelf: "flex-end", padding: 12 },
  pickerActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  todayButton: { padding: 12 },
  todayText: { color: colors.primary, fontWeight: "700" },
  closeText: { color: colors.primary, fontWeight: "700" },
});
