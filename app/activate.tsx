import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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

import { useLicense } from "@/contexts/LicenseContext";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function daysRemaining(expiresAt: number): number {
  if (expiresAt === Number.MAX_SAFE_INTEGER) return Infinity;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)));
}

// ─── Shared info row ──────────────────────────────────────────────────────────
function Row({ icon, label, value, valueColor, mono }: {
  icon: string; label: string; value: string;
  valueColor?: string; mono?: boolean;
}) {
  return (
    <View style={s.infoRow}>
      <Feather name={icon as never} size={13} color="#64748B" style={{ marginRight: 6 }} />
      <Text style={s.infoLabel}>{label}:</Text>
      <Text style={[s.infoValue, valueColor ? { color: valueColor } : {}, mono ? s.mono : {}]}>
        {value}
      </Text>
    </View>
  );
}

function Chip({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={s.chip}>
      <Feather name={icon as never} size={11} color="#F59E0B" />
      <Text style={s.chipText}>{text}</Text>
    </View>
  );
}

// ─── Device ID badge (shown on activation screen) ─────────────────────────────
function DeviceIdBadge({ deviceId }: { deviceId: string }) {
  if (!deviceId) return null;
  return (
    <View style={s.deviceCard}>
      <View style={s.deviceCardHeader}>
        <Feather name="cpu" size={13} color="#22D3A3" />
        <Text style={s.deviceCardTitle}>Your Device ID</Text>
        <Text style={s.deviceCardHint}>(share with Akhtar Zaib Khattak)</Text>
      </View>
      <Text style={s.deviceIdText} selectable>{deviceId}</Text>
    </View>
  );
}

// ─── Activation Screen ────────────────────────────────────────────────────────
function ActivationScreen() {
  const insets              = useSafeAreaInsets();
  const { activate, deviceId } = useLicense();
  const [key,     setKey]   = useState("");
  const [error,   setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleActivate = async () => {
    const trimmed = key.trim();
    if (!trimmed) { setError("Please enter your activation key."); return; }
    setLoading(true);
    setError("");
    const err = await activate(trimmed);
    setLoading(false);
    if (err) {
      setError(err);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const topPad = Platform.OS === "web" ? 40 : insets.top;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={[s.root, { paddingTop: topPad }]}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <StatusBar barStyle="light-content" />

        {/* Icon */}
        <View style={s.iconRing}>
          <View style={s.iconInner}>
            <Feather name="map" size={36} color="#F59E0B" />
          </View>
        </View>

        <Text style={s.appName}>Land Plot Measurer</Text>
        <Text style={s.tagline}>Professional land measurement & splitting tool</Text>
        <Text style={s.byLine}>by Akhtar Zaib Khattak</Text>

        <View style={s.divider} />

        {/* Device ID */}
        <DeviceIdBadge deviceId={deviceId} />

        <Text style={s.sectionTitle}>Enter Activation Key</Text>
        <Text style={s.sectionSub}>
          Your annual license key is bound to this device and activates the app for 365 days.
        </Text>

        <TextInput
          style={s.keyInput}
          value={key}
          onChangeText={t => { setKey(t); setError(""); }}
          placeholder="AZAK-XXXX-XXXX"
          placeholderTextColor="#334155"
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={handleActivate}
        />

        {!!error && (
          <View style={s.errorRow}>
            <Feather name="alert-circle" size={13} color="#EF4444" />
            <Text style={s.errorText}>{error}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[s.primaryBtn, loading && { opacity: 0.6 }]}
          onPress={handleActivate}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator size="small" color="#0B1120" />
            : <Feather name="unlock" size={16} color="#0B1120" />
          }
          <Text style={s.primaryBtnText}>{loading ? "Activating…" : "Activate License"}</Text>
        </TouchableOpacity>

        <View style={s.chips}>
          <Chip icon="cpu"        text="Device-Bound" />
          <Chip icon="clock"      text="1-Year License" />
          <Chip icon="shield"     text="Offline" />
          <Chip icon="refresh-cw" text="Annual Renewal" />
        </View>

        <Text style={s.contactText}>
          Contact <Text style={s.amber}>Akhtar Zaib Khattak</Text> with your Device ID above to obtain your key.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Expired Screen ───────────────────────────────────────────────────────────
function ExpiredScreen() {
  const insets = useSafeAreaInsets();
  const { record, activate, deviceId } = useLicense();
  const [key,       setKey]       = useState("");
  const [error,     setError]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const [showRenew, setShowRenew] = useState(false);

  const topPad = Platform.OS === "web" ? 40 : insets.top;

  const handleRenew = async () => {
    if (!key.trim()) { setError("Please enter your new activation key."); return; }
    setLoading(true); setError("");
    const err = await activate(key);
    setLoading(false);
    if (err) {
      setError(err);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  return (
    <ScrollView
      style={[s.root, { paddingTop: topPad }]}
      contentContainerStyle={s.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <StatusBar barStyle="light-content" />

      <View style={[s.iconRing, { marginBottom: 0 }]}>
        <View style={[s.iconInner, { borderColor: "#EF4444" }]}>
          <Feather name="lock" size={36} color="#EF4444" />
        </View>
      </View>

      <Text style={s.expiredTitle}>License Expired</Text>
      <Text style={s.expiredBody}>
        Please contact{" "}
        <Text style={s.amber}>Akhtar Zaib Khattak</Text>
        {" "}to renew your annual subscription.
      </Text>

      {record && (
        <View style={s.infoCard}>
          <Row icon="calendar"     label="Activated"   value={formatDate(record.activatedAt)} />
          <Row icon="alert-circle" label="Expired on"  value={formatDate(record.expiresAt)} valueColor="#EF4444" />
          <Row icon="key"          label="Key"         value={record.key} mono />
        </View>
      )}

      <DeviceIdBadge deviceId={deviceId} />

      {!showRenew ? (
        <TouchableOpacity style={s.primaryBtn} onPress={() => setShowRenew(true)}>
          <Feather name="refresh-cw" size={16} color="#0B1120" />
          <Text style={s.primaryBtnText}>Enter Renewal Key</Text>
        </TouchableOpacity>
      ) : (
        <View style={{ width: "100%", gap: 10 }}>
          <Text style={s.sectionSub}>Enter your new activation key:</Text>
          <TextInput
            style={s.keyInput}
            value={key}
            onChangeText={t => { setKey(t); setError(""); }}
            placeholder="AZAK-XXXX-XXXX"
            placeholderTextColor="#334155"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleRenew}
          />
          {!!error && (
            <View style={s.errorRow}>
              <Feather name="alert-circle" size={13} color="#EF4444" />
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[s.primaryBtn, loading && { opacity: 0.6 }]}
            onPress={handleRenew}
            disabled={loading}
          >
            {loading ? <ActivityIndicator size="small" color="#0B1120" /> : <Feather name="check" size={16} color="#0B1120" />}
            <Text style={s.primaryBtnText}>{loading ? "Activating…" : "Activate"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.cancelLink} onPress={() => { setShowRenew(false); setError(""); }}>
            <Text style={s.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Gate ─────────────────────────────────────────────────────────────────────
export default function LicenseGate({ children }: { children: React.ReactNode }) {
  const { status, record } = useLicense();

  if (status === "loading") {
    return (
      <View style={s.splash}>
        <ActivityIndicator size="large" color="#F59E0B" />
        <Text style={s.splashText}>Verifying license…</Text>
      </View>
    );
  }
  if (status === "expired")    return <ExpiredScreen />;
  if (status === "unlicensed") return <ActivationScreen />;

  // Active
  const days = record ? daysRemaining(record.expiresAt) : Infinity;
  return (
    <>
      {children}
      {days <= 30 && days !== Infinity && (
        <View style={s.ribbon} pointerEvents="none">
          <Feather name="alert-triangle" size={11} color="#FCD34D" />
          <Text style={s.ribbonText}>
            License expires in {days} day{days !== 1 ? "s" : ""} — contact Akhtar Zaib Khattak to renew
          </Text>
        </View>
      )}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: "#0B1120" },
  scrollContent:{ alignItems: "center", paddingHorizontal: 28, paddingBottom: 48, gap: 16 },
  splash:       { flex: 1, backgroundColor: "#0B1120", alignItems: "center", justifyContent: "center", gap: 16 },
  splashText:   { fontSize: 13, color: "#64748B" },

  iconRing:  { width: 100, height: 100, borderRadius: 50, borderWidth: 1, borderColor: "#1E2D45", alignItems: "center", justifyContent: "center", backgroundColor: "#0F1829", marginTop: 32 },
  iconInner: { width: 80, height: 80, borderRadius: 40, borderWidth: 2, borderColor: "#F59E0B", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(245,158,11,0.08)" },

  appName:  { fontSize: 22, fontWeight: "700", color: "#F0F4FF", textAlign: "center", letterSpacing: 0.3 },
  tagline:  { fontSize: 13, color: "#64748B", textAlign: "center", lineHeight: 18 },
  byLine:   { fontSize: 12, color: "#F59E0B", fontWeight: "600" },
  divider:  { width: 48, height: 2, backgroundColor: "#1E2D45", borderRadius: 1 },

  // Device ID card
  deviceCard:       { width: "100%", backgroundColor: "#0A1929", borderRadius: 12, borderWidth: 1, borderColor: "rgba(34,211,163,0.25)", padding: 14, gap: 8 },
  deviceCardHeader: { flexDirection: "row", alignItems: "center", gap: 7 },
  deviceCardTitle:  { fontSize: 12, fontWeight: "700", color: "#22D3A3" },
  deviceCardHint:   { fontSize: 11, color: "#475569", flex: 1 },
  deviceIdText:     { fontSize: 22, fontWeight: "700", color: "#F0F4FF", textAlign: "center", letterSpacing: 4, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },

  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#F0F4FF" },
  sectionSub:   { fontSize: 12, color: "#64748B", textAlign: "center", lineHeight: 17, width: "100%" },

  keyInput: {
    width: "100%", height: 52,
    backgroundColor: "#151F32", borderWidth: 1.5, borderColor: "#1E2D45",
    borderRadius: 12, paddingHorizontal: 18,
    fontSize: 18, fontWeight: "700", color: "#F59E0B",
    textAlign: "center", letterSpacing: 3,
  },

  errorRow:  { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start" },
  errorText: { fontSize: 12, color: "#EF4444", flex: 1 },

  primaryBtn:     { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, backgroundColor: "#F59E0B", paddingVertical: 14, borderRadius: 12 },
  primaryBtnText: { fontSize: 15, fontWeight: "700", color: "#0B1120" },

  chips:    { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  chip:     { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(245,158,11,0.08)", borderWidth: 1, borderColor: "rgba(245,158,11,0.2)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 11, color: "#F59E0B", fontWeight: "600" },

  contactText:  { fontSize: 12, color: "#475569", textAlign: "center", lineHeight: 18 },
  amber:        { color: "#F59E0B", fontWeight: "700" },

  expiredTitle: { fontSize: 22, fontWeight: "700", color: "#EF4444", textAlign: "center" },
  expiredBody:  { fontSize: 14, color: "#94A3B8", textAlign: "center", lineHeight: 22 },

  infoCard:  { width: "100%", backgroundColor: "#151F32", borderRadius: 12, borderWidth: 1, borderColor: "#1E2D45", padding: 14, gap: 10 },
  infoRow:   { flexDirection: "row", alignItems: "center" },
  infoLabel: { fontSize: 12, color: "#64748B", marginRight: 4 },
  infoValue: { fontSize: 12, color: "#CBD5E1", flex: 1 },
  mono:      { fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace", fontSize: 11 },

  cancelLink:     { alignSelf: "center", paddingVertical: 6 },
  cancelLinkText: { fontSize: 13, color: "#475569" },

  ribbon:     { position: "absolute", bottom: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "rgba(245,158,11,0.12)", borderTopWidth: 1, borderTopColor: "rgba(245,158,11,0.25)", paddingVertical: 6, paddingHorizontal: 16 },
  ribbonText: { fontSize: 11, color: "#FCD34D", fontWeight: "600", flex: 1, textAlign: "center" },
});
