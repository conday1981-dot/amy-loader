// A.M.Y Loader: live status of everything sideloading depends on.
// The Rust side (src-tauri/src/amy_status.rs) probes Apple, the anisette
// server and GitHub, and remembers how the last sign-in / install went; this
// adds what only the window knows (Apple ID, phones, secure storage).
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DeviceInfo } from "../Device";
import { DAY_MS, InstallRecord, expiresAt, formatWhen } from "./history";

export type Health = "ok" | "unknown" | "warn" | "down" | "blocked";

export type StatusItem = {
  id: string;
  label: string;
  state: Health;
  summary: string;
  fix?: string;
  atMs?: number;
};

type RustReport = {
  items: StatusItem[];
  checkedAtMs: number;
  identity: string;
  engineVersion: string;
};

export type SystemStatus = {
  items: StatusItem[];
  checkedAtMs: number | null;
  identity: string | null;
  checking: boolean;
  error: string | null;
  recheck: () => void;
};

/** Fired by the Rust side after every sign-in and install. */
export const STATUS_EVENT = "amy://status-changed";
const POLL_MS = 5 * 60 * 1000;
/** Re-check on focus if the last check is older than this. */
const STALE_MS = 2 * 60 * 1000;

const RANK: Record<Health, number> = { ok: 0, unknown: 1, warn: 2, down: 3, blocked: 4 };
const ORDER = ["runway", "internet", "signin", "anisette", "developer", "appleid", "phone", "install", "storage", "engine"];

export function worst(items: StatusItem[]): Health {
  return items.reduce<Health>((w, i) => (RANK[i.state] > RANK[w] ? i.state : w), "ok");
}

export function stateWord(h: Health): string {
  return { ok: "OK", unknown: "UNKNOWN", warn: "CHECK", down: "DOWN", blocked: "BLOCKED" }[h];
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleString();
}

type LocalInputs = {
  anisetteServer: string;
  installs: InstallRecord[];
  loggedInAs: string | null;
  connected: DeviceInfo[];
  selectedDevice: DeviceInfo | null;
  noKeyringAvailable: boolean;
};

/** How long until the first tracked app stops opening. */
function runwayItem(installs: InstallRecord[]): StatusItem {
  const label = "App expiry";
  if (installs.length === 0) return { id: "runway", label, state: "unknown", summary: "No apps tracked yet" };
  const soonest = installs.reduce((a, b) => (expiresAt(a).getTime() <= expiresAt(b).getTime() ? a : b));
  const left = expiresAt(soonest).getTime() - Date.now();
  const days = left / DAY_MS;
  const what = `${soonest.app} on ${soonest.deviceName}`;
  if (left <= 0) {
    return {
      id: "runway",
      label,
      state: "down",
      summary: `${what} has expired`,
      fix: "Don't delete it: its data comes back when it's re-signed. Re-sign it from the timeline once Apple sign-in is OK.",
    };
  }
  const when = formatWhen(expiresAt(soonest));
  const span = days >= 1 ? `${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"}` : `${Math.max(1, Math.round(left / 3_600_000))} h`;
  if (days < 1) {
    return { id: "runway", label, state: "down", summary: `${what} stops opening ${when} (${span} left)`, fix: "Keep the phone on home Wi-Fi and unlocked; A.M.Y retries every 30 minutes." };
  }
  if (days < 3) {
    return { id: "runway", label, state: "warn", summary: `${what} has ${span} left (until ${when})`, fix: "Fine for now. A.M.Y re-signs automatically as soon as Apple sign-in works." };
  }
  return { id: "runway", label, state: "ok", summary: `Every app has at least ${span} left (soonest: ${what})` };
}

function localItems(i: LocalInputs): StatusItem[] {
  const phones = i.connected;
  const wifi = phones.filter((p) => p.connectionType === "Network").length;
  return [
    runwayItem(i.installs),
    i.loggedInAs
      ? { id: "appleid", label: "Apple ID", state: "ok", summary: `Signed in as ${i.loggedInAs}` }
      : {
          id: "appleid",
          label: "Apple ID",
          state: "unknown",
          summary: "Not signed in",
          fix: "Sign in with the signing-only Apple ID under APPLE IDS.",
        },
    phones.length > 0
      ? {
          id: "phone",
          label: "iPhones",
          state: "ok",
          summary:
            `${phones.length} found (${phones.map((p) => p.name).join(", ")})` +
            (wifi ? ` · ${wifi} over Wi-Fi` : "") +
            (i.selectedDevice ? ` · ${i.selectedDevice.name} selected` : " · none selected"),
        }
      : {
          id: "phone",
          label: "iPhones",
          state: "warn",
          summary: "No phone found",
          fix: "Plug the phone in once (and tap Trust), or keep it unlocked on the same Wi-Fi, then press Ctrl+R.",
        },
    i.noKeyringAvailable
      ? {
          id: "storage",
          label: "Secure storage",
          state: "warn",
          summary: "Windows Credential Manager isn't available, so passwords and pairing files are stored on disk",
        }
      : { id: "storage", label: "Secure storage", state: "ok", summary: "Passwords and pairing files are in Windows Credential Manager" },
  ];
}

export function useSystemStatus(inputs: LocalInputs): SystemStatus {
  const [remote, setRemote] = useState<RustReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverRef = useRef(inputs.anisetteServer);
  serverRef.current = inputs.anisetteServer;
  const inFlight = useRef(false);
  const lastRun = useRef(0);

  const run = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastRun.current = Date.now();
    setChecking(true);
    try {
      const report = await invoke<RustReport>("amy_status_check", { anisetteServer: serverRef.current, force });
      setRemote(report);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  // First check, a timer, and a re-check when the window comes back.
  useEffect(() => {
    run(false);
    const timer = setInterval(() => {
      if (!document.hidden) run(false);
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastRun.current > STALE_MS) run(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [run]);

  // After each sign-in / install, and when the anisette server changes.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const unlisten = listen(STATUS_EVENT, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => run(false), 400);
    });
    return () => {
      clearTimeout(debounce);
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [run]);

  const firstServer = useRef(true);
  useEffect(() => {
    if (firstServer.current) {
      firstServer.current = false;
      return;
    }
    run(false);
  }, [inputs.anisetteServer, run]);

  const items = [...(remote?.items ?? []), ...localItems(inputs)].sort(
    (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );
  if (!remote && error) {
    items.unshift({
      id: "checker",
      label: "Status checker",
      state: "unknown",
      summary: `Couldn't run the checks: ${error}`,
    });
  }

  return {
    items,
    checkedAtMs: remote?.checkedAtMs ?? null,
    identity: remote?.identity ?? null,
    checking,
    error,
    recheck: () => run(true),
  };
}
