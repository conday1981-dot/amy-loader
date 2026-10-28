// A.M.Y Loader — install history and phone ↔ Apple ID memory.
//
// The iloader engine doesn't keep a record of what was installed where, so the
// A.M.Y shell keeps its own small log (stored locally in amy.json via
// tauri-plugin-store, next to iloader's own data.json/preferences.json).
// It powers the week timeline, "re-sign" buttons and the Phase 2 auto-refresh.
import { load, Store } from "@tauri-apps/plugin-store";

/** Free Apple IDs sign apps for 7 days. */
export const FREE_SIGNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InstallRecord = {
  id: string;
  /** Display name, taken from the .ipa file name. */
  app: string;
  /** Full path of the .ipa on this PC, so it can be re-signed later. */
  ipaPath: string;
  deviceUuid: string;
  deviceName: string;
  appleId: string;
  /** ISO timestamp of the successful install. */
  signedAt: string;
};

type AmyData = {
  installs: InstallRecord[];
  /** deviceUuid → the Apple ID last used for that phone. */
  deviceAccounts: Record<string, string>;
};

let storePromise: Promise<Store> | null = null;
function store() {
  if (!storePromise) storePromise = load("amy.json");
  return storePromise;
}

async function read(): Promise<AmyData> {
  const s = await store();
  return {
    installs: (await s.get<InstallRecord[]>("installs")) ?? [],
    deviceAccounts: (await s.get<Record<string, string>>("deviceAccounts")) ?? {},
  };
}

export async function getAmyData(): Promise<AmyData> {
  return read();
}

export function appNameFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.ipa$/i, "").replace(/[_-]+/g, " ").trim() || file;
}

/**
 * Record a successful install. An app (same name) on the same phone replaces
 * its previous record, so the list is "what's on each phone now".
 */
export async function recordInstall(
  rec: Omit<InstallRecord, "id" | "signedAt"> & { signedAt?: string },
): Promise<void> {
  const s = await store();
  const data = await read();
  const signedAt = rec.signedAt ?? new Date().toISOString();
  const installs = data.installs.filter(
    (r) => !(r.deviceUuid === rec.deviceUuid && r.app.toLowerCase() === rec.app.toLowerCase()),
  );
  installs.push({ ...rec, signedAt, id: `${rec.deviceUuid}:${rec.app}:${signedAt}` });
  await s.set("installs", installs);
  await s.set("deviceAccounts", { ...data.deviceAccounts, [rec.deviceUuid]: rec.appleId });
  await s.save();
}

export async function forgetInstall(id: string): Promise<void> {
  const s = await store();
  const data = await read();
  await s.set("installs", data.installs.filter((r) => r.id !== id));
  await s.save();
}

export function expiresAt(rec: InstallRecord): Date {
  return new Date(new Date(rec.signedAt).getTime() + FREE_SIGNING_DAYS * DAY_MS);
}

/** Whole days left (can be negative once expired). */
export function daysLeft(rec: InstallRecord, now = new Date()): number {
  return Math.floor((expiresAt(rec).getTime() - now.getTime()) / DAY_MS);
}

/** "2d", "today", "expired" … for compact labels. */
export function daysLeftLabel(rec: InstallRecord, now = new Date()): string {
  const ms = expiresAt(rec).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const d = Math.floor(ms / DAY_MS);
  if (d === 0) return `${Math.max(1, Math.round(ms / 3600000))}h`;
  return `${d}d`;
}

/** Status band used for colour: ok (>3d), soon (1–3d), urgent (<1d), expired. */
export function urgency(rec: InstallRecord, now = new Date()): "ok" | "soon" | "urgent" | "expired" {
  const ms = expiresAt(rec).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  if (ms < DAY_MS) return "urgent";
  if (ms <= 3 * DAY_MS) return "soon";
  return "ok";
}
