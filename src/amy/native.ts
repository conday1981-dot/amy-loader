// A.M.Y Loader: bridges to the A.M.Y Rust commands (src-tauri/src/amy.rs),
// phone alerts via ntfy, and A.M.Y's own update feed.
import { invoke } from "@tauri-apps/api/core";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AmySettings } from "./history";

export type BackgroundState = { autostart: boolean; closeToTray: boolean; launchedInBackground: boolean };

/** Fired by the tray menu's "Refresh apps now". */
export const TRAY_REFRESH_EVENT = "amy://refresh-now";

export function getBackground(): Promise<BackgroundState> {
  return invoke<BackgroundState>("amy_get_background");
}

/** Start with Windows (hidden) + close to tray, on or off together. */
export function setBackground(enabled: boolean): Promise<void> {
  return invoke("amy_set_background", { enabled });
}

export function showWindow(): Promise<void> {
  return invoke("amy_show_window");
}

/** Windows toast notification. Never throws. */
export async function notifyDesktop(title: string, body: string): Promise<void> {
  try {
    await invoke("amy_notify", { title, body });
  } catch (e) {
    console.error("Desktop notification failed", e);
  }
}

export type PhoneAlert = {
  title: string;
  message: string;
  /** ntfy priority 1–5 (3 = default, 4 = high). */
  priority?: number;
  /** ntfy tags → emoji on the phone, e.g. "white_check_mark", "warning". */
  tags?: string[];
};

/**
 * Push an alert to the iPhone through ntfy. Uses ntfy's JSON publishing
 * (POST to the server root) with a text/plain body, so it is a "simple" CORS
 * request and UTF-8 titles are fine. Throws on failure (the caller logs it).
 * Messages never include Apple ID emails.
 */
export async function pushToPhone(settings: Pick<AmySettings, "ntfyServer" | "ntfyTopic">, alert: PhoneAlert): Promise<void> {
  if (!settings.ntfyTopic) return;
  const res = await fetch(`${settings.ntfyServer}/`, {
    method: "POST",
    body: JSON.stringify({
      topic: settings.ntfyTopic,
      title: alert.title,
      message: alert.message,
      priority: alert.priority ?? 3,
      tags: alert.tags ?? [],
    }),
  });
  if (!res.ok) throw new Error(`ntfy replied ${res.status} ${res.statusText}`);
}

/** A hard-to-guess topic name: anyone who knows a ntfy.sh topic can read it. */
export function randomTopic(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "amy-loader-" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

/** Ask A.M.Y's update feed whether a newer build exists. */
export async function checkForAmyUpdate(): Promise<Update | null> {
  return check({ timeout: 20_000 });
}

/** Download, verify (signature checked by the updater) and install, then restart. */
export async function installAmyUpdate(update: Update, onProgress?: (pct: number | null) => void): Promise<void> {
  let total = 0;
  let got = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress?.(total ? 0 : null);
    } else if (event.event === "Progress") {
      got += event.data.chunkLength;
      onProgress?.(total ? Math.min(100, Math.round((got / total) * 100)) : null);
    } else if (event.event === "Finished") {
      onProgress?.(100);
    }
  });
  await relaunch();
}
