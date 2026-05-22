/**
 * License / Activation Key Context — v2 with Device Binding
 * ──────────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS
 *
 *   Each device gets a unique 10-char Device ID generated on first launch and
 *   stored in AsyncStorage. The key formula mixes this ID in, so a key generated
 *   for Device A will not validate on Device B.
 *
 * KEY GENERATION (admin use only — keep private):
 *
 *   A = weakHash(deviceId)         → integer 1000-9999
 *   dh = djb2(deviceId) % 9999     → integer 0-9998
 *   B = (A × 73 + dh + 2947) % 9999
 *   Key = `AZAK-{A.padStart(4)}-{B.padStart(4)}`
 *
 *   Admin panel inside the app calculates this automatically.
 *   Admin master key to open panel: AKHTAR_ZAIB_VIP_2026
 *
 * EXPIRY: 365 days from activation (admin key never expires).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const STORAGE_KEY   = "land_plot_license_v1";
const DEVICE_ID_KEY = "land_plot_device_id_v1";
const MS_PER_YEAR   = 365 * 24 * 60 * 60 * 1000;
const ADMIN_MASTER  = "AKHTAR_ZAIB_VIP_2026";

export type LicenseStatus = "loading" | "unlicensed" | "active" | "expired";

export interface LicenseRecord {
  key:         string;
  activatedAt: number;
  expiresAt:   number; // Number.MAX_SAFE_INTEGER for admin
  isAdmin:     boolean;
}

interface LicenseCtx {
  status:   LicenseStatus;
  record:   LicenseRecord | null;
  deviceId: string;
  isAdmin:  boolean;
  /** Returns null on success, or an error string on failure. */
  activate:   (rawKey: string) => Promise<string | null>;
  deactivate: () => Promise<void>;
}

const Ctx = createContext<LicenseCtx | null>(null);

// ─── Crypto helpers ───────────────────────────────────────────────────────────

/** DJB2 hash → 0-9998 */
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h % 9999;
}

/** Produces unique A (1000-9999) per device ID. */
function weakHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 41) + str.charCodeAt(i)) >>> 0;
  }
  return (h % 9000) + 1000;
}

/** Generate a random 10-char device ID (unambiguous charset). */
function generateDeviceId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Public: compute the activation key for a given device ID. */
export function generateKeyForDevice(deviceId: string): string {
  const a  = weakHash(deviceId);
  const dh = djb2(deviceId);
  const b  = (a * 73 + dh + 2947) % 9999;
  return `AZAK-${a.toString().padStart(4, "0")}-${b.toString().padStart(4, "0")}`;
}

/** Validate a raw key string against the device's own ID. */
function validateKey(
  raw: string,
  deviceId: string
): { canonical: string; isAdmin: boolean } | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, "");

  // Admin master key — never expires, unlocks admin panel
  if (cleaned === ADMIN_MASTER) {
    return { canonical: ADMIN_MASTER, isAdmin: true };
  }

  const match = cleaned.match(/^AZAK-(\d{1,4})-(\d{1,4})$/);
  if (!match) return null;
  const a = parseInt(match[1], 10);
  const b = parseInt(match[2], 10);
  const dh       = djb2(deviceId);
  const expected = (a * 73 + dh + 2947) % 9999;
  if (b !== expected) return null;
  return {
    canonical: `AZAK-${a.toString().padStart(4, "0")}-${b.toString().padStart(4, "0")}`,
    isAdmin:   false,
  };
}

function computeStatus(record: LicenseRecord | null): LicenseStatus {
  if (!record) return "unlicensed";
  if (record.isAdmin) return "active"; // admin never expires
  return Date.now() < record.expiresAt ? "active" : "expired";
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [deviceId, setDeviceId] = useState("");
  const [record,   setRecord]   = useState<LicenseRecord | null>(null);
  const [status,   setStatus]   = useState<LicenseStatus>("loading");

  useEffect(() => {
    (async () => {
      // 1. Load or generate device ID
      let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (!id) {
        id = generateDeviceId();
        await AsyncStorage.setItem(DEVICE_ID_KEY, id);
      }
      setDeviceId(id);

      // 2. Load persisted license
      const json = await AsyncStorage.getItem(STORAGE_KEY);
      if (!json) { setStatus("unlicensed"); return; }
      try {
        const rec: LicenseRecord = JSON.parse(json);
        setRecord(rec);
        setStatus(computeStatus(rec));
      } catch {
        setStatus("unlicensed");
      }
    })();
  }, []);

  const activate = useCallback(
    async (rawKey: string): Promise<string | null> => {
      if (!deviceId) return "Device ID not ready yet. Please wait a moment.";
      const result = validateKey(rawKey, deviceId);
      if (!result) {
        return "Invalid activation key. This key may not match your device. Contact Akhtar Zaib Khattak.";
      }
      const now      = Date.now();
      const expiresAt = result.isAdmin ? Number.MAX_SAFE_INTEGER : now + MS_PER_YEAR;
      const rec: LicenseRecord = {
        key:         result.canonical,
        activatedAt: now,
        expiresAt,
        isAdmin:     result.isAdmin,
      };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
      setRecord(rec);
      setStatus("active");
      return null;
    },
    [deviceId]
  );

  const deactivate = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setRecord(null);
    setStatus("unlicensed");
  }, []);

  return (
    <Ctx.Provider value={{
      status, record, deviceId,
      isAdmin: record?.isAdmin ?? false,
      activate, deactivate,
    }}>
      {children}
    </Ctx.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLicense(): LicenseCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLicense must be used within LicenseProvider");
  return ctx;
}
