// A.M.Y Loader — install history, phone ↔ Apple ID memory, auto-refresh
// settings and activity log.
//
// The iloader engine doesn't keep a record of what was installed where, so the
// A.M.Y shell keeps its own small file (amy.json in %APPDATA%\uk.amy.loader via
// tauri-plugin-store, next to iloader's own data.json/preferences.json).
// It powers the week timeline, re-sign buttons and auto-refresh.
import { load, Store } from "@tauri-apps/plugin-store";

/** Free Apple IDs sign apps for 7 days. */
export const FREE_SIGNING_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_LIMIT = 300;

export type InstallRecord = {
  id: string;
  /** Display name, taken from the .ipa file name. */
  app: string;
  /** Full path of the .ipa on this PC, so it can be re-signed later. */
  ipaPath: string;
  /**
   * The phone's UDID. Empty for records saved by 1.0.x (which read the wrong
   * field); those are matched to a phone by name the next time it connects.
   */
  deviceUdid: string;
  deviceName: string;
  appleId: string;
  /** ISO timestamp of the last successful signing. */
  signedAt: string;
};

export type AmySettings = {
  /** Re-sign apps automatically before they expire. */
  autoRefresh: boolean;
  /** How many days before expiry to start trying. */
  leadDays: number;
  /** Start with Windows (hidden in the tray) and keep running when closed. */
  background: boolean;
  /** ntfy topic for phone alerts; empty = off. */
  ntfyTopic: string;
  /** ntfy server (default the public ntfy.sh; can be self-hosted). */
  ntfyServer: string;
  /** Check the A.M.Y update feed on start. */
  checkUpdates: boolean;
};

export const DEFAULT_SETTINGS: AmySettings = {
  autoRefresh: true,
  leadDays: 2,
  background: true,
  ntfyTopic: "",
  ntfyServer: "https://ntfy.sh",
  checkUpdates: true,
};

export type LogLevel = "info" | "ok" | "warn" | "error";
export type LogEntry = { at: string; level: LogLevel; msg: string };

/** Per-record bookkeeping so failures back off and warnings aren't repeated. */
export type RecordState = { lastAttempt?: string; failures?: number; lastWarned?: string };

export type AmyData = {
  installs: InstallRecord[];
  /** device UDID → the Apple ID last used for that phone. */
  deviceAccounts: Record<string, string>;
};

let storePromise: Promise<Store> | null = null;
function store() {
  if (!storePromise) storePromise = load("amy.json");
  return storePromise;
}

type StoredRecord = InstallRecord & { deviceUuid?: string };

function normalise(r: StoredRecord): InstallRecord {
  const { deviceUuid, ...rest } = r;
  return { ...rest, deviceUdid: r.deviceUdid ?? (typeof deviceUuid === "string" ? deviceUuid : "") };
}

async function read(): Promise<AmyData> {
  const s = await store();
  const installs = ((await s.get<StoredRecord[]>("installs")) ?? []).map(normalise);
  const accounts = (await s.get<Record<string, string>>("deviceAccounts")) ?? {};
  // 1.0.x keyed accounts by an undefined id; drop those keys.
  const deviceAccounts = Object.fromEntries(
    Object.entries(accounts).filter(([k]) => k && k !== "undefined" && k !== "null"),
  );
  return { installs, deviceAccounts };
}

export async function getAmyData(): Promise<AmyData> {
  return read();
}

/** Stable lane key: the UDID, or the phone name for old records without one. */
export function deviceKey(rec: Pick<InstallRecord, "deviceUdid" | "deviceName">): string {
  return rec.deviceUdid || `name:${rec.deviceName}`;
}

export function appNameFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.ipa$/i, "").replace(/[_-]+/g, " ").trim() || file;
}

function recordId(udidOrKey: string, app: string, signedAt: string) {
  return `${udidOrKey}:${app}:${signedAt}`;
}

/**
 * Record a successful install. An app (same name) on the same phone replaces
 * its previous record, so the list is "what's on each phone now".
 */
export async function recordInstall(
  rec: Omit<InstallRecord, "id" | "signedAt"> & { signedAt?: string },
): Promise<InstallRecord> {
  const s = await store();
  const data = await read();
  const signedAt = rec.signedAt ?? new Date().toISOString();
  const key = deviceKey(rec);
  const sameApp = (r: InstallRecord) =>
    r.app.toLowerCase() === rec.app.toLowerCase() &&
    (deviceKey(r) === key || (!r.deviceUdid && r.deviceName === rec.deviceName));
  const previous = data.installs.filter(sameApp);
  const installs = data.installs.filter((r) => !sameApp(r));
  const saved: InstallRecord = { ...rec, signedAt, id: recordId(key, rec.app, signedAt) };
  installs.push(saved);
  await s.set("installs", installs);
  if (rec.deviceUdid) {
    await s.set("deviceAccounts", { ...data.deviceAccounts, [rec.deviceUdid]: rec.appleId });
  }
  // bookkeeping for replaced records is no longer needed
  if (previous.length) {
    const states = await getRecordStates();
    for (const p of previous) delete states[p.id];
    await s.set("recordStates", states);
  }
  await s.save();
  return saved;
}

export async function forgetInstall(id: string): Promise<void> {
  const s = await store();
  const data = await read();
  await s.set("installs", data.installs.filter((r) => r.id !== id));
  const states = await getRecordStates();
  delete states[id];
  await s.set("recordStates", states);
  await s.save();
}

/**
 * Give 1.0.x records (no UDID) the UDID of the connected phone with the same
 * name. Only when exactly one connected phone has that name, so two phones
 * both called "iPhone" are never mixed up. Returns true if anything changed.
 */
export async function backfillDeviceIds(connected: { name: string; udid: string }[]): Promise<boolean> {
  const data = await read();
  let changed = false;
  const accounts = { ...data.deviceAccounts };
  const installs = data.installs.map((r) => {
    if (r.deviceUdid) return r;
    const matches = connected.filter((d) => d.name === r.deviceName && d.udid);
    if (matches.length !== 1) return r;
    changed = true;
    const udid = matches[0].udid;
    if (!accounts[udid]) accounts[udid] = r.appleId;
    return { ...r, deviceUdid: udid };
  });
  if (!changed) return false;
  const s = await store();
  await s.set("installs", installs);
  await s.set("deviceAccounts", accounts);
  await s.save();
  return true;
}

// ── settings ────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<AmySettings> {
  const s = await store();
  return { ...DEFAULT_SETTINGS, ...((await s.get<Partial<AmySettings>>("settings")) ?? {}) };
}

export async function saveSettings(patch: Partial<AmySettings>): Promise<AmySettings> {
  const s = await store();
  const next = { ...(await getSettings()), ...patch };
  next.leadDays = Math.min(5, Math.max(1, Math.round(next.leadDays)));
  next.ntfyTopic = next.ntfyTopic.trim();
  next.ntfyServer = (next.ntfyServer.trim() || DEFAULT_SETTINGS.ntfyServer).replace(/\/+$/, "");
  await s.set("settings", next);
  await s.save();
  return next;
}

// ── activity log ────────────────────────────────────────────────────────────

export async function getLog(): Promise<LogEntry[]> {
  const s = await store();
  return (await s.get<LogEntry[]>("log")) ?? [];
}

export async function appendLog(level: LogLevel, msg: string): Promise<LogEntry[]> {
  const s = await store();
  const log = [{ at: new Date().toISOString(), level, msg }, ...(await getLog())].slice(0, LOG_LIMIT);
  await s.set("log", log);
  await s.save();
  return log;
}

export async function clearLog(): Promise<void> {
  const s = await store();
  await s.set("log", []);
  await s.save();
}

// ── per-record state (backoff, warnings) ───────────────────────────────────

export async function getRecordStates(): Promise<Record<string, RecordState>> {
  const s = await store();
  return (await s.get<Record<string, RecordState>>("recordStates")) ?? {};
}

export async function patchRecordState(id: string, patch: RecordState): Promise<void> {
  const s = await store();
  const states = await getRecordStates();
  states[id] = { ...states[id], ...patch };
  await s.set("recordStates", states);
  await s.save();
}

// ── time helpers ───────────────────────────────────────────────────────────

export function expiresAt(rec: InstallRecord): Date {
  return new Date(new Date(rec.signedAt).getTime() + FREE_SIGNING_DAYS * DAY_MS);
}

/** Whole days left (can be negative once expired). */
export function daysLeft(rec: InstallRecord, now = new Date()): number {
  return Math.floor((expiresAt(rec).getTime() - now.getTime()) / DAY_MS);
}

/** "2d", "5h", "expired" … for compact labels. */
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

/** When auto-refresh starts trying for this record. */
export function refreshDueAt(rec: InstallRecord, leadDays: number): Date {
  return new Date(expiresAt(rec).getTime() - leadDays * DAY_MS);
}

export function formatWhen(d: Date): string {
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
