// A.M.Y Loader — auto-refresh engine.
//
// Every few minutes (and on start-up, from the tray menu, or from the
// Auto-refresh panel) this looks for tracked apps that are within
// `leadDays` of expiring (default 6: re-sign once an app is a day old, so an
// Apple sign-in outage has days to clear before anything expires). For each one whose phone is reachable (USB, or
// Wi-Fi via "Sync with this iPhone over Wi-Fi") it selects the phone, signs in
// with the Apple ID that app was signed with, and re-installs the same .ipa
// using iloader's own commands — so the engine itself is unchanged.
//
// Nothing here talks to anything except Apple (through iloader) and, if a
// topic is set, the ntfy server for phone alerts.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppError } from "../errors";
import type { DeviceInfo } from "../Device";
import {
  AmySettings,
  DAY_MS,
  InstallRecord,
  appendLog,
  backfillDeviceIds,
  expiresAt,
  formatWhen,
  getAmyData,
  getRecordStates,
  getSettings,
  patchRecordState,
  recordInstall,
  refreshDueAt,
} from "./history";
import { TRAY_REFRESH_EVENT, notifyDesktop, pushToPhone, showWindow } from "./native";
import { installWithProgress } from "./installer";

const TICK_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 45 * 1000;
const SELECT_TIMEOUT_MS = 90 * 1000;
/** Re-warn about an unreachable phone at most this often. */
const WARN_EVERY_MS = 12 * 60 * 60 * 1000;
/** Alert (unreachable phone, failed refresh) once expiry is this close. */
const WARN_WITHIN_MS = 2 * DAY_MS;

/** "update": install a newly downloaded library version on the phones that have the app. */
export type RefreshReason = "timer" | "startup" | "tray" | "manual" | "test" | "update";

export type PassResult = { message: string; refreshed: number };

export type AutoRefreshStatus = {
  running: boolean;
  step: string | null;
  lastRun: Date | null;
  lastResult: string | null;
};

type Deps = {
  loggedInAs: string | null;
  setLoggedInAs: (email: string | null) => void;
  setSelectedDevice: (d: DeviceInfo | null) => void;
  /** A manual operation is on screen; don't start a pass under it. */
  manualBusy: boolean;
  anisetteServer: string;
  /** Called after records change so the timeline redraws. */
  onHistoryChanged: () => void;
  /** Called with the device list each pass fetches (keeps the UI in step). */
  onDevices?: (devices: DeviceInfo[]) => void;
};

function describe(e: unknown): string {
  const ae = e as Partial<AppError> | undefined;
  const msg = (ae && typeof ae === "object" && "message" in ae ? ae.message : String(e)) || "Unknown error";
  switch (ae?.type) {
    case "device_coms":
    case "device_coms_with_message":
    case "usbmuxd":
    case "house_arrest":
      return `couldn't talk to the phone (${msg}). Unlock it and keep it on the same Wi-Fi.`;
    case "max_apps":
      return `Apple's free-account limit of 3 sideloaded apps per phone was hit (${msg}).`;
    case "not_enough_app_ids":
      return `this Apple ID has run out of App IDs for the week (${msg}).`;
    case "auth":
    case "anisette":
      return `Apple sign-in failed (${msg}).`;
    case "filesystem":
      return `the .ipa couldn't be read — has it moved? (${msg})`;
    default:
      return msg;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => {
      onTimeout();
      reject({ type: "canceled", message: `timed out after ${Math.round(ms / 1000)}s` });
    }, ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

/**
 * Back-off after failures: 10, 20, 40, 80… minutes, capped by how much time
 * the app has left. With days in hand it waits up to 6 hours between tries,
 * so an Apple sign-in outage isn't hammered (repeated sign-ins can get an
 * Apple ID throttled); it tries harder as expiry gets close.
 */
export function backoffMs(failures: number, msLeft: number) {
  if (!failures) return 0;
  const hours = msLeft / (60 * 60 * 1000);
  const capMin = hours > 48 ? 360 : hours > 24 ? 120 : hours > 6 ? 60 : 30;
  return Math.min(capMin, 10 * 2 ** Math.min(failures - 1, 10)) * 60 * 1000;
}

async function listDevices(): Promise<DeviceInfo[]> {
  const results = await invoke<Array<{ Ok: DeviceInfo } | { Err: AppError }>>("list_devices");
  return results.flatMap((r) => ("Ok" in r ? [r.Ok] : []));
}

export function useAutoRefresh(deps: Deps) {
  const [status, setStatus] = useState<AutoRefreshStatus>({ running: false, step: null, lastRun: null, lastResult: null });
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const runningRef = useRef(false);
  /** Account the engine believes is signed in (state updates lag behind). */
  const accountRef = useRef<string | null>(deps.loggedInAs);
  useEffect(() => {
    if (!runningRef.current) accountRef.current = deps.loggedInAs;
  }, [deps.loggedInAs]);

  const step = (s: string | null) => setStatus((v) => ({ ...v, step: s }));

  const alert = useCallback(async (settings: AmySettings, title: string, message: string, opts: { priority?: number; tags?: string[]; desktop?: boolean } = {}) => {
    if (opts.desktop !== false) await notifyDesktop(title, message);
    try {
      await pushToPhone(settings, { title, message, priority: opts.priority, tags: opts.tags });
    } catch (e) {
      await appendLog("warn", `Phone alert not sent: ${String((e as Error)?.message ?? e)}`);
    }
  }, []);

  const runPass = useCallback(
    async (reason: RefreshReason, only?: string[]): Promise<PassResult> => {
      if (runningRef.current) return { message: "A refresh is already running.", refreshed: 0 };
      const d = depsRef.current;
      if (d.manualBusy) {
        const message = reason === "timer" || reason === "startup" ? "Skipped: an install is on screen." : "Finish or close the current install first.";
        return { message, refreshed: 0 };
      }
      const settings = await getSettings();
      const interactive = reason === "manual" || reason === "test" || reason === "tray";
      const isUpdate = reason === "update";
      if (!settings.autoRefresh && !interactive && !isUpdate) return { message: "Auto-refresh is off.", refreshed: 0 };

      runningRef.current = true;
      accountRef.current = d.loggedInAs;
      setStatus((v) => ({ ...v, running: true, step: "Checking what's due" }));
      let summary = "";
      let refreshed = 0;
      try {
        let { installs } = await getAmyData();
        const states = await getRecordStates();
        const now = Date.now();
        const force = reason === "test" || isUpdate;
        const due = installs.filter((r) => {
          if (only && !only.includes(r.id)) return false;
          if (!force && now < refreshDueAt(r, settings.leadDays).getTime()) return false;
          const st = states[r.id];
          if (!force && st?.lastAttempt && now - new Date(st.lastAttempt).getTime() < backoffMs(st.failures ?? 0, expiresAt(r).getTime() - now)) return false;
          return true;
        });
        if (due.length === 0) {
          summary = installs.length ? "Nothing due yet." : "No apps tracked yet.";
          if (interactive) await appendLog("info", `Checked (${reason}): nothing due.`);
          return { message: summary, refreshed };
        }

        step("Looking for phones");
        let devices: DeviceInfo[] = [];
        try {
          devices = await listDevices();
          d.onDevices?.(devices);
        } catch (e) {
          await appendLog("error", `Couldn't list phones: ${describe(e)}`);
        }
        if (await backfillDeviceIds(devices)) {
          installs = (await getAmyData()).installs;
          d.onHistoryChanged();
        }
        const fresh = new Map(installs.map((r) => [r.id, r]));
        const findDevice = (r: InstallRecord) =>
          (r.deviceUdid && devices.find((x) => x.udid === r.deviceUdid)) ||
          (!r.deviceUdid && devices.filter((x) => x.name === r.deviceName).length === 1
            ? devices.find((x) => x.name === r.deviceName)
            : undefined);

        // Phones that aren't reachable: warn when it's getting tight.
        const reachable: { rec: InstallRecord; device: DeviceInfo }[] = [];
        for (const original of due) {
          const rec = fresh.get(original.id) ?? original;
          const device = findDevice(rec);
          if (device) {
            reachable.push({ rec, device });
            continue;
          }
          const left = expiresAt(rec).getTime() - now;
          const st = states[rec.id];
          const recentlyWarned = st?.lastWarned && now - new Date(st.lastWarned).getTime() < WARN_EVERY_MS;
          if (left < WARN_WITHIN_MS && !recentlyWarned) {
            const when = left <= 0 ? "has expired" : `expires ${formatWhen(expiresAt(rec))}`;
            await appendLog("warn", `${rec.deviceName} not found, so ${rec.app} wasn't refreshed (${when}).`);
            await alert(
              settings,
              `Connect ${rec.deviceName}`,
              `${rec.app} ${when}. Put the phone on home Wi-Fi (or plug it into the laptop) and unlock it — A.M.Y Loader will refresh it automatically.`,
              { priority: 4, tags: ["warning"] },
            );
            await patchRecordState(rec.id, { lastWarned: new Date().toISOString() });
          } else if (interactive) {
            await appendLog("info", `${rec.deviceName} not connected; ${rec.app} will be refreshed when it is.`);
          }
        }
        if (reachable.length === 0) {
          summary = "Apps are due, but their phones aren't connected.";
          return { message: summary, refreshed };
        }

        // Group by phone, then by Apple ID (current account first = fewer sign-ins).
        const byPhone = new Map<string, { device: DeviceInfo; recs: InstallRecord[] }>();
        for (const { rec, device } of reachable) {
          if (!byPhone.has(device.udid)) byPhone.set(device.udid, { device, recs: [] });
          byPhone.get(device.udid)!.recs.push(rec);
        }

        const done: { rec: InstallRecord; saved: InstallRecord }[] = [];
        const failed: { rec: InstallRecord; why: string }[] = [];

        for (const { device, recs } of byPhone.values()) {
          step(`Connecting to ${device.name}`);
          try {
            await withTimeout(invoke("set_selected_device", { device }), SELECT_TIMEOUT_MS, () => {
              invoke("cancel_pairing").catch(() => {});
            });
            d.setSelectedDevice(device);
          } catch (e) {
            const why = describe(e);
            for (const rec of recs) failed.push({ rec, why: `couldn't connect to ${device.name}: ${why}` });
            continue;
          }

          const accounts = [...new Set(recs.map((r) => r.appleId))].sort((a, b) =>
            a === accountRef.current ? -1 : b === accountRef.current ? 1 : 0,
          );
          for (const appleId of accounts) {
            if (accountRef.current !== appleId) {
              step(`Signing in to the Apple ID for ${device.name}`);
              try {
                await invoke("invalidate_account");
                accountRef.current = null;
                d.setLoggedInAs(null);
                await invoke("login_stored", { email: appleId, anisetteServer: depsRef.current.anisetteServer });
                accountRef.current = appleId;
                d.setLoggedInAs(appleId);
              } catch (e) {
                const why = describe(e);
                for (const rec of recs.filter((r) => r.appleId === appleId)) failed.push({ rec, why: `sign-in failed: ${why}` });
                continue;
              }
            }
            for (const rec of recs.filter((r) => r.appleId === appleId)) {
              step(`${isUpdate ? "Updating" : "Re-signing"} ${rec.app} on ${device.name}`);
              await patchRecordState(rec.id, { lastAttempt: new Date().toISOString() });
              try {
                const { info, appName } = await installWithProgress(rec.ipaPath, device, isUpdate ? "update" : "refresh");
                const saved = await recordInstall({
                  app: info ? appName : rec.app,
                  ipaPath: rec.ipaPath,
                  deviceUdid: device.udid,
                  deviceName: device.name,
                  appleId,
                  bundleId: info?.bundleId ?? rec.bundleId,
                  version: info?.version ?? rec.version,
                });
                done.push({ rec, saved });
                await appendLog(
                  "ok",
                  `${isUpdate ? `Updated ${saved.app} to ${saved.version ?? "the new version"}` : `Re-signed ${saved.app}`} on ${device.name}; good until ${formatWhen(expiresAt(saved))}.`,
                );
                d.onHistoryChanged();
              } catch (e) {
                failed.push({ rec, why: describe(e) });
              }
            }
          }
        }

        const states2 = await getRecordStates();
        for (const { rec, why } of failed) {
          const failures = (states2[rec.id]?.failures ?? 0) + 1;
          await patchRecordState(rec.id, { failures, lastAttempt: new Date().toISOString() });
          await appendLog("error", `${rec.app} on ${rec.deviceName}: ${why}`);
          const left = expiresAt(rec).getTime() - Date.now();
          // Tell the phone on the first failure if it's close, and then only every few tries.
          if (left < WARN_WITHIN_MS && (failures === 1 || failures % 4 === 0)) {
            await alert(settings, `Couldn't refresh ${rec.app}`, `On ${rec.deviceName}: ${why} It ${left <= 0 ? "has expired" : `expires ${formatWhen(expiresAt(rec))}`}.`, {
              priority: 4,
              tags: ["x"],
            });
          }
        }

        if (done.length) {
          const until = formatWhen(new Date(Math.min(...done.map((x) => expiresAt(x.saved).getTime()))));
          const phones = [...new Set(done.map((x) => x.rec.deviceName))];
          const what = phones
            .map((p) => `${done.filter((x) => x.rec.deviceName === p).map((x) => x.rec.app).join(", ")} on ${p}`)
            .join("; ");
          await alert(settings, `${isUpdate ? "Updated" : "Refreshed"} ${done.length} app${done.length > 1 ? "s" : ""}`, `${what}. Good until ${until}.`, {
            tags: ["white_check_mark"],
          });
        }
        refreshed = done.length;
        summary = `${done.length} ${isUpdate ? "updated" : "refreshed"}${failed.length ? `, ${failed.length} failed` : ""}.`;
        return { message: summary, refreshed };
      } catch (e) {
        summary = `Refresh stopped: ${describe(e)}`;
        await appendLog("error", summary);
        return { message: summary, refreshed };
      } finally {
        runningRef.current = false;
        setStatus({ running: false, step: null, lastRun: new Date(), lastResult: summary || null });
        depsRef.current.onHistoryChanged();
      }
    },
    [alert],
  );

  // While a pass runs, Apple may ask for a 2FA code or for a certificate to
  // be revoked. iloader's own dialogs handle the answer; bring the window up
  // and tell the phone so someone sees it.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const attention = async (title: string, message: string) => {
      if (!runningRef.current) return;
      await showWindow().catch(() => {});
      const settings = await getSettings();
      await alert(settings, title, message, { priority: 5, tags: ["rotating_light"] });
      await appendLog("warn", `${title}: ${message}`);
    };
    listen("2fa-required", () =>
      attention("Apple needs a code", "A.M.Y Loader is refreshing your apps and Apple asked for a two-factor code. Enter it on the laptop within 2 minutes."),
    ).then((u) => (cancelled ? u() : unsubs.push(u)));
    listen("max-certs-reached", () =>
      attention("Certificate limit reached", "Apple's certificate limit was hit while refreshing. Choose a certificate to revoke on the laptop."),
    ).then((u) => (cancelled ? u() : unsubs.push(u)));
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [alert]);

  // Timer, start-up pass and tray menu.
  useEffect(() => {
    const startup = setTimeout(() => runPass("startup"), STARTUP_DELAY_MS);
    const tick = setInterval(() => runPass("timer"), TICK_MS);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen(TRAY_REFRESH_EVENT, async () => {
      const res = await runPass("tray");
      // a successful refresh already sent its own notification
      if (res.refreshed === 0) await notifyDesktop("A.M.Y Loader", res.message);
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      clearTimeout(startup);
      clearInterval(tick);
      unlisten?.();
    };
  }, [runPass]);

  return { status, runPass };
}
