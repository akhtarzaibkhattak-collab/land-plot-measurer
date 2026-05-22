import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SavedPlot, usePlotStorage } from "@/contexts/PlotStorage";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PlotCard({
  plot,
  onLoad,
  onDelete,
}: {
  plot: SavedPlot;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const dirLabel =
    plot.splitDir === "length" ? "Split by Length" : "Split by Breadth";
  const dirIcon = plot.splitDir === "length" ? "|||" : "≡";
  const numDiv = parseInt(plot.divisions) || 0;

  return (
    <View style={styles.card}>
      {/* Top row: name + actions */}
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Feather name="map" size={15} color="#F59E0B" style={{ marginRight: 8 }} />
          <Text style={styles.cardName} numberOfLines={1}>
            {plot.name}
          </Text>
        </View>
        <View style={styles.cardActions}>
          <TouchableOpacity style={styles.loadBtn} onPress={onLoad}>
            <Feather name="upload" size={13} color="#0B1120" />
            <Text style={styles.loadBtnText}>Load</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.deleteBtn} onPress={onDelete}>
            <Feather name="trash-2" size={14} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <View style={styles.statBlock}>
          <Text style={styles.statValue}>
            {plot.sqFt != null
              ? plot.sqFt.toLocaleString("en-US", { maximumFractionDigits: 1 })
              : "—"}
          </Text>
          <Text style={styles.statLabel}>SQ FT</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBlock}>
          <Text style={[styles.statValue, { color: "#F59E0B" }]}>
            {plot.marlas != null ? plot.marlas.toFixed(3) : "—"}
          </Text>
          <Text style={styles.statLabel}>MARLAS</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBlock}>
          <Text style={styles.statValue}>{plot.points.length}</Text>
          <Text style={styles.statLabel}>CORNERS</Text>
        </View>
      </View>

      {/* Footer row: scale / divisions / date */}
      <View style={styles.cardFooter}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {dirIcon} {dirLabel}
          </Text>
        </View>
        {numDiv >= 2 && (
          <View style={[styles.badge, styles.badgeGreen]}>
            <Text style={[styles.badgeText, { color: "#22D3A3" }]}>
              {numDiv} parts
            </Text>
          </View>
        )}
        {plot.scaleWidth ? (
          <View style={[styles.badge, styles.badgeBlue]}>
            <Text style={[styles.badgeText, { color: "#93C5FD" }]}>
              {plot.scaleWidth} ft wide
            </Text>
          </View>
        ) : null}
        <Text style={styles.dateText}>{formatDate(plot.createdAt)}</Text>
      </View>
    </View>
  );
}

export default function SavedScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { savedPlots, deletePlot, loadPlot } = usePlotStorage();
  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const handleLoad = (plot: SavedPlot) => {
    loadPlot(plot);
    if (Platform.OS !== "web")
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.navigate("/(tabs)/");
  };

  const handleDelete = (plot: SavedPlot) => {
    Alert.alert(
      "Delete Plot",
      `Remove "${plot.name}" permanently?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deletePlot(plot.id);
            if (Platform.OS !== "web")
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          },
        },
      ],
      { cancelable: true }
    );
  };

  return (
    <View style={[styles.root, { paddingTop: topPad }]}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Saved Plots</Text>
          <Text style={styles.headerSub}>
            {savedPlots.length === 0
              ? "No plots saved yet"
              : `${savedPlots.length} plot${savedPlots.length === 1 ? "" : "s"} stored locally`}
          </Text>
        </View>
        <View style={styles.countBubble}>
          <Text style={styles.countText}>{savedPlots.length}</Text>
        </View>
      </View>

      {savedPlots.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Feather name="bookmark" size={42} color="#1E2D45" />
          </View>
          <Text style={styles.emptyTitle}>No saved plots</Text>
          <Text style={styles.emptyHint}>
            Draw a plot on the Measure tab, then tap the{" "}
            <Text style={{ color: "#22D3A3" }}>Save</Text> button to store it
            here for later.
          </Text>
          <TouchableOpacity
            style={styles.goMeasureBtn}
            onPress={() => router.navigate("/(tabs)/")}
          >
            <Feather name="edit-2" size={14} color="#0B1120" />
            <Text style={styles.goMeasureText}>Go to Measure</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={savedPlots}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PlotCard
              plot={item}
              onLoad={() => handleLoad(item)}
              onDelete={() => handleDelete(item)}
            />
          )}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 16 },
          ]}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B1120" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1E2D45",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F0F4FF",
    letterSpacing: 0.2,
  },
  headerSub: { fontSize: 11, color: "#64748B", marginTop: 2 },
  countBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#151F32",
    borderWidth: 1,
    borderColor: "#1E2D45",
    alignItems: "center",
    justifyContent: "center",
  },
  countText: { fontSize: 14, fontWeight: "700", color: "#F59E0B" },

  list: { padding: 12, gap: 12 },

  card: {
    backgroundColor: "#151F32",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E2D45",
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#1a2842",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: 8,
  },
  cardName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F0F4FF",
    flex: 1,
  },
  cardActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  loadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#F59E0B",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  loadBtnText: { fontSize: 12, fontWeight: "700", color: "#0B1120" },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(239,68,68,0.1)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },

  statsRow: {
    flexDirection: "row",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#1a2842",
  },
  statBlock: { flex: 1, alignItems: "center" },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F0F4FF",
    letterSpacing: -0.3,
  },
  statLabel: { fontSize: 9, color: "#64748B", marginTop: 2, letterSpacing: 0.7 },
  statDivider: { width: 1, backgroundColor: "#1E2D45", marginVertical: 4 },

  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  badge: {
    backgroundColor: "rgba(245,158,11,0.1)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.2)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  badgeGreen: {
    backgroundColor: "rgba(34,211,163,0.08)",
    borderColor: "rgba(34,211,163,0.2)",
  },
  badgeBlue: {
    backgroundColor: "rgba(147,197,253,0.08)",
    borderColor: "rgba(147,197,253,0.2)",
  },
  badgeText: { fontSize: 10, fontWeight: "600", color: "#F59E0B" },
  dateText: { fontSize: 10, color: "#475569", marginLeft: "auto" },

  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#0F1829",
    borderWidth: 1,
    borderColor: "#1E2D45",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#F0F4FF" },
  emptyHint: {
    fontSize: 13,
    color: "#475569",
    textAlign: "center",
    lineHeight: 20,
  },
  goMeasureBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    backgroundColor: "#F59E0B",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  goMeasureText: { fontSize: 13, fontWeight: "700", color: "#0B1120" },
});
