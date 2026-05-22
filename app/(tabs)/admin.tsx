import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { generateKeyForDevice, useLicense } from "@/contexts/LicenseContext";

export default function AdminPanel() {
  const insets   = useSafeAreaInsets();
  const { deviceId, record, deactivate } = useLicense();

  const [clientId,      setClientId]      = useState("");
  const [generatedKey,  setGeneratedKey]  = useState("");
  const [keyReady,      setKeyReady]      = useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  // Generate key as user types (live)
  const handleClientIdChange = (text: string) => {
    const cleaned = text.trim().toUpperCase();
    setClientId(text);
    if (cleaned.length >= 4) {
      const key = generateKeyForDevice(cleaned);
      setGeneratedKey(key);
      setKeyReady(true);
    } else {
      setGeneratedKey("");
      setKeyReady(false);
    }
  };

  const handleGenerateForOwn = () => {
    if (!deviceId) return;
    const key = generateKeyForDevice(deviceId);
    setClientId(deviceId);
    setGeneratedKey(key);
    setKeyReady(true);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleDeactivate = () => {
    Alert.alert(
      "Deactivate License",
      "This will remove the current license from this device. You'll need to enter a valid key again.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Deactivate", style: "destructive", onPress: deactivate },
      ]
    );
  };

  return (
    <ScrollView
      style={[styles.root, { paddingTop: topPad }]}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.adminBadge}>
            <Feather name="shield" size={13} color="#F59E0B" />
            <Text style={styles.adminBadgeText}>ADMIN MODE</Text>
          </View>
          <Text style={styles.headerTitle}>Key Generator</Text>
          <Text style={styles.headerSub}>Akhtar Zaib Khattak — Private Panel</Text>
        </View>
      </View>

      {/* This device's info */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>YOUR DEVICE</Text>
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <Feather name="cpu" size={14} color="#22D3A3" />
            <Text style={styles.cardLabel}>Device ID</Text>
            <Text style={styles.deviceIdValue} selectable>{deviceId || "Loading…"}</Text>
          </View>
          {deviceId && (
            <View style={styles.cardRow}>
              <Feather name="key" size={14} color="#22D3A3" />
              <Text style={styles.cardLabel}>Your Key</Text>
              <Text style={styles.keyValue} selectable>{generateKeyForDevice(deviceId)}</Text>
            </View>
          )}
          {record && (
            <View style={styles.cardRow}>
              <Feather name="check-circle" size={14} color="#4ade80" />
              <Text style={styles.cardLabel}>Status</Text>
              <Text style={{ fontSize: 13, color: "#4ade80", fontWeight: "700" }}>
                Admin — Never Expires
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Key generator */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>GENERATE KEY FOR CLIENT</Text>
        <Text style={styles.sectionHint}>
          Ask the client to share their Device ID from the activation screen, then enter it below.
        </Text>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.clientInput}
            value={clientId}
            onChangeText={handleClientIdChange}
            placeholder="Paste client Device ID here"
            placeholderTextColor="#334155"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
          />
          <TouchableOpacity style={styles.ownBtn} onPress={handleGenerateForOwn}>
            <Feather name="user" size={14} color="#F59E0B" />
            <Text style={styles.ownBtnText}>Mine</Text>
          </TouchableOpacity>
        </View>

        {keyReady && generatedKey ? (
          <View style={styles.resultCard}>
            <View style={styles.resultHeader}>
              <Feather name="check-circle" size={15} color="#4ade80" />
              <Text style={styles.resultTitle}>Activation Key Generated</Text>
            </View>
            <Text style={styles.resultKey} selectable>{generatedKey}</Text>
            <Text style={styles.resultNote}>
              ↑ Long-press to copy · Send this key to your client
            </Text>
            <View style={styles.resultMeta}>
              <View style={styles.metaChip}>
                <Feather name="cpu" size={11} color="#64748B" />
                <Text style={styles.metaText}>
                  Bound to: {clientId.trim().toUpperCase()}
                </Text>
              </View>
              <View style={styles.metaChip}>
                <Feather name="clock" size={11} color="#64748B" />
                <Text style={styles.metaText}>Valid 365 days</Text>
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.emptyResult}>
            <Feather name="hash" size={28} color="#1E2D45" />
            <Text style={styles.emptyResultText}>
              Enter a Device ID (min. 4 chars) to instantly see the key
            </Text>
          </View>
        )}
      </View>

      {/* How it works */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>HOW THE FORMULA WORKS</Text>
        <View style={styles.formulaCard}>
          <Text style={styles.formulaLine}>A  = weakHash(deviceId)         →  1000–9999</Text>
          <Text style={styles.formulaLine}>dh = djb2(deviceId) mod 9999   →  0–9998</Text>
          <Text style={styles.formulaLine}>B  = (A × 73 + dh + 2947) mod 9999</Text>
          <View style={styles.formulaDivider} />
          <Text style={styles.formulaKey}>Key = AZAK-{"{A}"}-{"{B}"}</Text>
          <Text style={styles.formulaNote}>Each device ID maps to exactly one unique key.</Text>
        </View>
      </View>

      {/* Danger zone */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: "#EF4444" }]}>DEVICE MANAGEMENT</Text>
        <TouchableOpacity style={styles.deactivateBtn} onPress={handleDeactivate}>
          <Feather name="trash-2" size={14} color="#EF4444" />
          <Text style={styles.deactivateBtnText}>Deactivate This Device</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: "#0B1120" },
  content: { paddingHorizontal: 16, gap: 20 },

  header:      { paddingVertical: 8 },
  headerLeft:  { gap: 3 },
  adminBadge:  { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(245,158,11,0.12)", borderWidth: 1, borderColor: "rgba(245,158,11,0.3)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  adminBadgeText: { fontSize: 10, color: "#F59E0B", fontWeight: "800", letterSpacing: 1 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#F0F4FF" },
  headerSub:   { fontSize: 12, color: "#64748B" },

  section:      { gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: "700", color: "#64748B", letterSpacing: 1 },
  sectionHint:  { fontSize: 12, color: "#475569", lineHeight: 17 },

  card:      { backgroundColor: "#151F32", borderRadius: 12, borderWidth: 1, borderColor: "#1E2D45", padding: 14, gap: 12 },
  cardRow:   { flexDirection: "row", alignItems: "center", gap: 10 },
  cardLabel: { fontSize: 12, color: "#64748B", width: 72 },

  deviceIdValue: { fontSize: 14, fontWeight: "700", color: "#22D3A3", flex: 1, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace", letterSpacing: 1.5 },
  keyValue:      { fontSize: 13, fontWeight: "700", color: "#F59E0B", flex: 1, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace", letterSpacing: 1 },

  inputRow:    { flexDirection: "row", gap: 8 },
  clientInput: { flex: 1, height: 48, backgroundColor: "#151F32", borderWidth: 1.5, borderColor: "#1E2D45", borderRadius: 10, paddingHorizontal: 14, fontSize: 14, fontWeight: "600", color: "#F0F4FF", letterSpacing: 1.5 },
  ownBtn:      { height: 48, paddingHorizontal: 14, backgroundColor: "rgba(245,158,11,0.1)", borderWidth: 1, borderColor: "rgba(245,158,11,0.3)", borderRadius: 10, alignItems: "center", justifyContent: "center", gap: 4, flexDirection: "row" },
  ownBtnText:  { fontSize: 12, fontWeight: "700", color: "#F59E0B" },

  resultCard:    { backgroundColor: "#0A1929", borderRadius: 12, borderWidth: 1.5, borderColor: "rgba(74,222,128,0.3)", padding: 18, gap: 12, alignItems: "center" },
  resultHeader:  { flexDirection: "row", alignItems: "center", gap: 8 },
  resultTitle:   { fontSize: 14, fontWeight: "700", color: "#4ade80" },
  resultKey:     { fontSize: 26, fontWeight: "800", color: "#F59E0B", letterSpacing: 4, textAlign: "center", fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  resultNote:    { fontSize: 11, color: "#475569", fontStyle: "italic" },
  resultMeta:    { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  metaChip:      { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#151F32", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  metaText:      { fontSize: 11, color: "#64748B" },

  emptyResult:     { alignItems: "center", justifyContent: "center", paddingVertical: 28, gap: 10 },
  emptyResultText: { fontSize: 13, color: "#2D3F58", textAlign: "center", lineHeight: 18 },

  formulaCard:    { backgroundColor: "#0A1929", borderRadius: 12, borderWidth: 1, borderColor: "#1E2D45", padding: 16, gap: 6 },
  formulaLine:    { fontSize: 12, color: "#64748B", fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  formulaDivider: { height: 1, backgroundColor: "#1E2D45", marginVertical: 4 },
  formulaKey:     { fontSize: 14, fontWeight: "700", color: "#F59E0B", fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  formulaNote:    { fontSize: 11, color: "#475569", fontStyle: "italic" },

  deactivateBtn:     { flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: "rgba(239,68,68,0.08)", borderWidth: 1, borderColor: "rgba(239,68,68,0.25)", borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16 },
  deactivateBtnText: { fontSize: 14, fontWeight: "600", color: "#EF4444" },
});
