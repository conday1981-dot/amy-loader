import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { AppleID } from "./AppleID";
import { Device, DeviceInfo } from "./Device";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  installSideStoreOperation,
  installLiveContainerOperation,
  Operation,
  OperationState,
  OperationUpdate,
} from "./components/operations";
import { listen } from "@tauri-apps/api/event";
import OperationView from "./components/OperationView";
import { toast } from "sonner";
import { Modal } from "./components/Modal";
import { Certificates } from "./pages/Certificates";
import { AppIds } from "./pages/AppIds";
import { Settings } from "./pages/Settings";
import { Pairing } from "./pages/Pairing";
import { getVersion } from "@tauri-apps/api/app";
import { useTranslation } from "react-i18next";
import { usePlatform } from "./PlatformContext";
import { useStore } from "./StoreContext";
import { useError } from "./ErrorContext";
import { AmyMark } from "./amy/AmyMark";
import { Timeline } from "./amy/Timeline";
import {
  AmySettings,
  DEFAULT_SETTINGS,
  InstallRecord,
  backfillDeviceIds,
  expiresAt,
  forgetInstall,
  appendLog,
  formatWhen,
  getAmyData,
  getSettings,
  recordInstall,
  refreshDueAt,
  retargetInstalls,
} from "./amy/history";
import type { AppError } from "./errors";
import { InstallDock } from "./amy/InstallProgress";
import { startProgressListener } from "./amy/progress";
import { installWithProgress } from "./amy/installer";
import { LibraryPanel } from "./amy/LibraryPanel";
import { CheckResult, LibraryApp, checkLibrary, importToLibrary, listLibrary } from "./amy/library";
import { useAutoRefresh } from "./amy/autorefresh";
import { AutoRefreshPanel } from "./amy/AutoRefreshPanel";
import { TrackModal } from "./amy/TrackModal";
import { checkForAmyUpdate, installAmyUpdate, notifyDesktop, setBackground } from "./amy/native";
import { UPSTREAM_ENGINE_VERSION, UPSTREAM_URL } from "./amy/meta";
import "./amy/strings";
// Loaded last so the A.M.Y theme overrides iloader's component styles.
import "./amy/amy.css";

type ModalName = null | "certificates" | "appids" | "pairing" | "settings" | "autorefresh" | "track";

const UPDATE_CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
/** How often the library looks for new app versions. */
const LIBRARY_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Shown only when an install fails, so iloader's error screen and suggestions still appear. */
const amySideloadOperation: Operation = {
  id: "amy_sideload",
  titleKey: "operations.sideload_title",
  steps: [{ id: "install", titleKey: "operations.sideload_step_install" }],
};

function App() {
  const { t } = useTranslation();
  const { err } = useError();

  const [operationState, setOperationState] = useState<OperationState | null>(null);
  const [loggedInAs, setLoggedInAs] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [connected, setConnected] = useState<DeviceInfo[]>([]);
  const [installs, setInstalls] = useState<InstallRecord[]>([]);
  const [deviceAccounts, setDeviceAccounts] = useState<Record<string, string>>({});
  const [openModal, setOpenModal] = useState<ModalName>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [anisetteServer] = useStore<string>("anisetteServer3-1", "mac-ani.jkcoxson.com");
  const [amySettings, setAmySettings] = useState<AmySettings>(DEFAULT_SETTINGS);
  const [updateState, setUpdateState] = useState<string>("Not checked yet");
  const [library, setLibrary] = useState<LibraryApp[]>([]);
  const [libraryChecking, setLibraryChecking] = useState(false);
  const [manualInstalling, setManualInstalling] = useState(false);

  const refreshDevicesRef = useRef<(() => void) | null>(null);
  const [noKeyringAvailable, setNoKeyringAvailable] = useState<boolean>(false);
  const { platform } = usePlatform();

  const checkKeyring = useCallback(async () => {
    try {
      const available = await invoke<boolean>("keyring_available");
      setNoKeyringAvailable(!available);
    } catch (e) {
      console.error("Unable to check keyring availability:", e);
      setNoKeyringAvailable(true);
    }
  }, []);

  useEffect(() => {
    checkKeyring();
  }, [checkKeyring]);

  useEffect(() => {
    startProgressListener();
  }, []);

  const reloadLibrary = useCallback(async () => {
    try {
      setLibrary(await listLibrary());
    } catch (e) {
      console.error("Unable to load the app library", e);
    }
  }, []);

  useEffect(() => {
    reloadLibrary();
  }, [reloadLibrary]);

  useEffect(() => {
    // iloader's checkForUpdates() is deliberately not called: it pulls nab138's
    // builds, which would replace A.M.Y Loader. A.M.Y's own feed is used below.
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // Load A.M.Y settings and make "start with Windows / close to tray" match them.
  useEffect(() => {
    getSettings()
      .then(async (s) => {
        setAmySettings(s);
        await setBackground(s.background).catch((e) => console.error("Unable to apply background setting", e));
      })
      .catch((e) => console.error("Unable to load A.M.Y settings", e));
  }, []);

  const reloadHistory = useCallback(async () => {
    try {
      const data = await getAmyData();
      setInstalls(data.installs);
      setDeviceAccounts(data.deviceAccounts);
    } catch (e) {
      console.error("Unable to load A.M.Y history", e);
    }
  }, []);

  useEffect(() => {
    reloadHistory();
    // keep countdowns fresh while the app is left open
    const id = setInterval(() => setInstalls((v) => [...v]), 60_000);
    return () => clearInterval(id);
  }, [reloadHistory]);

  const handleDevices = useCallback(
    (devices: DeviceInfo[]) => {
      setConnected(devices);
      backfillDeviceIds(devices)
        .then((changed) => {
          if (changed) reloadHistory();
        })
        .catch(() => {});
    },
    [reloadHistory],
  );

  const auto = useAutoRefresh({
    loggedInAs,
    setLoggedInAs,
    setSelectedDevice,
    manualBusy: operationState !== null || manualInstalling,
    anisetteServer,
    onHistoryChanged: reloadHistory,
    onDevices: handleDevices,
  });

  const shortcutLabel = useCallback(
    (mac: string, windows: string, linux?: string) => {
      if (platform === "mac") return mac;
      if (platform === "linux") return linux ?? windows;
      return windows;
    },
    [platform],
  );

  const startOperation = useCallback(
    async (operation: Operation, params: { [key: string]: any }): Promise<void> => {
      setOperationState({ current: operation, started: [], failed: [], completed: [] });
      return new Promise<void>(async (resolve, reject) => {
        const unlistenFn = await listen<OperationUpdate>("operation_" + operation.id, (event) => {
          setOperationState((old) => {
            if (old == null) return null;
            if (event.payload.updateType === "started") {
              return { ...old, started: [...old.started, event.payload.stepId] };
            } else if (event.payload.updateType === "finished") {
              return { ...old, completed: [...old.completed, event.payload.stepId] };
            } else if (event.payload.updateType === "failed") {
              return {
                ...old,
                failed: [...old.failed, { stepId: event.payload.stepId, extraDetails: event.payload.extraDetails }],
              };
            }
            return old;
          });
        });
        try {
          await invoke(operation.id + "_operation", params);
          unlistenFn();
          resolve();
        } catch (e) {
          unlistenFn();
          reject(e);
        }
      });
    },
    [setOperationState],
  );

  const ensuredLoggedIn = useCallback((): boolean => {
    if (loggedInAs) return true;
    toast.error(t("app.must_be_logged_in"));
    return false;
  }, [loggedInAs, t]);

  const ensureSelectedDevice = useCallback((): boolean => {
    if (selectedDevice) return true;
    toast.error(t("app.must_select_device"));
    return false;
  }, [selectedDevice, t]);

  /** Install (or re-sign) one .ipa on the selected phone, with live progress, and record it. */
  const installIpa = useCallback(
    async (path: string) => {
      if (auto.status.running) {
        toast.error("Auto-refresh is working. Try again in a moment.");
        return;
      }
      if (manualInstalling) {
        toast.error("An install is already running.");
        return;
      }
      if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
      const device = selectedDevice!;
      const appleId = loggedInAs!;
      setManualInstalling(true);
      try {
        const { info, appName } = await installWithProgress(path, device, "install");
        await recordInstall({
          app: appName,
          ipaPath: path,
          deviceUdid: device.udid,
          deviceName: device.name,
          appleId,
          bundleId: info?.bundleId,
          version: info?.version,
        });
        await reloadHistory();
        toast.success(`${appName}${info ? ` ${info.version}` : ""} installed on ${device.name}`);
      } catch (e) {
        // Show iloader's error screen (with its suggestions) for the failure.
        setOperationState({
          current: amySideloadOperation,
          started: ["install"],
          completed: [],
          failed: [{ stepId: "install", extraDetails: e as AppError }],
        });
      } finally {
        setManualInstalling(false);
      }
    },
    [ensuredLoggedIn, ensureSelectedDevice, selectedDevice, loggedInAs, reloadHistory, auto.status.running, manualInstalling],
  );

  /**
   * Save an .ipa (or a .zip with an .ipa inside, e.g. a GitHub build artifact)
   * into the library, then install that copy if a phone and Apple ID are ready.
   */
  const addIpa = useCallback(
    async (path: string) => {
      const id = toast.loading("Saving to the A.M.Y library…");
      let saved;
      try {
        saved = await importToLibrary(path);
      } catch (e) {
        toast.error(`Couldn't add that file: ${String(e)}`, { id });
        return;
      }
      const { app, version } = saved;
      // Records that used the original file now use the library copy.
      await retargetInstalls(app.bundleId, [path], version.path).catch(() => []);
      await reloadLibrary();
      await reloadHistory();
      if (loggedInAs && selectedDevice) {
        toast.success(`${app.name} ${version.version} saved — installing on ${selectedDevice.name}`, { id });
        installIpa(version.path);
      } else {
        toast.success(`${app.name} ${version.version} saved to the library. Choose a phone and Apple ID, then press Install.`, { id });
      }
    },
    [installIpa, loggedInAs, selectedDevice, reloadLibrary, reloadHistory],
  );

  const chooseIpa = useCallback(async () => {
    const path = await openFileDialog({
      multiple: false,
      filters: [{ name: "Apps (.ipa, or .zip containing an .ipa)", extensions: ["ipa", "zip"] }],
    });
    if (!path) return;
    addIpa(path as string);
  }, [addIpa]);

  const switchAccount = useCallback(
    (email: string) => {
      const promise = async () => {
        await invoke("invalidate_account");
        await invoke("login_stored", { email, anisetteServer });
        setLoggedInAs(await invoke<string | null>("logged_in_as"));
      };
      toast.promise(promise, {
        loading: `Switching to ${email}…`,
        success: `Signed in as ${email}`,
        error: (e) => err(t("apple_id.login_failed"), e),
      });
    },
    [anisetteServer, err, t],
  );

  const resign = useCallback(
    (rec: InstallRecord) => {
      const samePhone = rec.deviceUdid ? selectedDevice?.udid === rec.deviceUdid : selectedDevice?.name === rec.deviceName;
      if (!selectedDevice || !samePhone) {
        toast.error(`Select ${rec.deviceName} in Phones first`);
        return;
      }
      if (loggedInAs !== rec.appleId) {
        toast.error(`${rec.app} was signed with ${rec.appleId}. Switch to that Apple ID first.`, {
          action: { label: "Switch", onClick: () => switchAccount(rec.appleId) },
        });
        return;
      }
      installIpa(rec.ipaPath);
    },
    [selectedDevice, loggedInAs, installIpa, switchAccount],
  );

  const forget = useCallback(
    async (rec: InstallRecord) => {
      await forgetInstall(rec.id);
      await reloadHistory();
      toast.success(`Stopped tracking ${rec.app} on ${rec.deviceName}`);
    },
    [reloadHistory],
  );

  // Drag an .ipa anywhere onto the window to install it.
  const addIpaRef = useRef(addIpa);
  addIpaRef.current = addIpa;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDragOver(true);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          const files = p.paths.filter((x) => /\.(ipa|zip)$/i.test(x));
          if (files.length === 0) {
            toast.error(
              p.paths.length === 0
                ? "Nothing arrived. If you dragged from inside a zip in Explorer, drop the .zip itself instead."
                : "That isn't an .ipa (or a .zip containing one)",
            );
            return;
          }
          if (files.length > 1) toast.info("Adding the first file — drop one at a time");
          addIpaRef.current(files[0]);
        }
      })
      .then((fn) => (unlisten = fn))
      .catch((e) => console.error("Drag and drop unavailable", e));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === undefined) return;
      const key = event.key.toLowerCase();
      const primaryPressed = platform === "mac" ? event.metaKey : event.ctrlKey;
      if (!primaryPressed) return;
      if (!event.shiftKey && key === "p") {
        event.preventDefault();
        if (!ensureSelectedDevice()) return;
        setOpenModal("pairing");
      } else if (event.shiftKey && key === "c") {
        event.preventDefault();
        if (!ensuredLoggedIn()) return;
        setOpenModal("certificates");
      } else if (event.shiftKey && key === "a") {
        event.preventDefault();
        if (!ensuredLoggedIn()) return;
        setOpenModal("appids");
      } else if (!event.shiftKey && key === "r") {
        event.preventDefault();
        refreshDevicesRef.current?.();
      } else if (!event.shiftKey && key === "o") {
        event.preventDefault();
        chooseIpa();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [platform, ensureSelectedDevice, ensuredLoggedIn, chooseIpa]);

  const runInstaller = (op: Operation, nightly: boolean, liveContainer: boolean) => {
    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
    startOperation(op, { nightly, liveContainer }).catch((e) => {
      console.log(e.type);
      console.error(e.message);
    });
  };

  const busy = operationState !== null || auto.status.running || manualInstalling;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // ── library updates ──────────────────────────────────────────────────────
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const libraryCheckingRef = useRef(false);

  const runLibraryCheck = useCallback(
    async (bundleId?: string, interactive = false) => {
      if (libraryCheckingRef.current) return;
      libraryCheckingRef.current = true;
      setLibraryChecking(true);
      const before = libraryRef.current;
      try {
        let results: CheckResult[];
        try {
          results = await checkLibrary(bundleId);
        } catch (e) {
          if (interactive) toast.error(`Update check failed: ${String(e)}`);
          return;
        }
        await reloadLibrary();
        for (const r of results.filter((x) => x.status === "updated" && x.path)) {
          const prev = before.find((a) => a.bundleId === r.bundleId);
          // Re-signs always use the newest library copy from now on.
          const changed = await retargetInstalls(r.bundleId, prev?.versions.map((v) => v.path) ?? [], r.path!);
          await reloadHistory();
          const phones = [...new Set(changed.map((c) => c.deviceName))];
          await appendLog("ok", `${r.message}.${phones.length ? ` On ${phones.join(", ")}.` : ""}`);
          if (changed.length && prev?.autoInstall) {
            await notifyDesktop(`${r.name} ${r.version ?? ""} downloaded`, `Installing it on ${phones.join(", ")}.`);
            const res = await autoRef.current.runPass("update", changed.map((c) => c.id));
            if (res.refreshed === 0) {
              await appendLog("info", `${r.name}: ${res.message} It will go on at the next re-sign.`);
            }
          } else {
            await notifyDesktop(
              `${r.name} ${r.version ?? ""} downloaded`,
              changed.length ? "Open A.M.Y Loader to install it now, or it goes on at the next re-sign." : "Saved to the library.",
            );
            if (changed.length) {
              toast(`${r.name} ${r.version ?? ""} is ready`, {
                duration: Infinity,
                action: {
                  label: "Install now",
                  onClick: () => {
                    autoRef.current.runPass("update", changed.map((c) => c.id)).then((res) => toast(res.message));
                  },
                },
              });
            }
          }
        }
        if (interactive) {
          const errors = results.filter((x) => x.status === "error");
          const updated = results.filter((x) => x.status === "updated").length;
          if (errors.length) errors.forEach((x) => toast.error(`${x.name}: ${x.message}`));
          else if (updated === 0) toast.success(results.length === 1 ? results[0].message : "Everything is up to date");
        }
      } finally {
        libraryCheckingRef.current = false;
        setLibraryChecking(false);
      }
    },
    [reloadLibrary, reloadHistory],
  );

  useEffect(() => {
    const run = () => {
      if (libraryRef.current.some((a) => a.source)) runLibraryCheck(undefined, false);
    };
    const first = setTimeout(run, 90_000);
    const every = setInterval(run, LIBRARY_CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [runLibraryCheck]);

  const installedOn = useCallback(
    (app: LibraryApp) => [
      ...new Set(
        installs
          .filter((r) => r.bundleId === app.bundleId || app.versions.some((v) => v.path === r.ipaPath))
          .map((r) => r.deviceName),
      ),
    ],
    [installs],
  );

  // ── A.M.Y self-update ─────────────────────────────────────────────────────
  const installUpdate = useCallback(async (u: Update) => {
    if (busyRef.current) {
      toast.error("Wait for the current install or refresh to finish, then update.");
      return;
    }
    const p = installAmyUpdate(u, (pct) => setUpdateState(pct === null ? `Downloading ${u.version}…` : `Downloading ${u.version}: ${pct}%`));
    toast.promise(p, {
      loading: `Updating to ${u.version}…`,
      success: "Installed. Restarting…",
      error: (e) => `Update failed: ${String(e)}`,
    });
    p.catch((e) => setUpdateState(`Update failed: ${String(e)}`));
  }, []);

  const checkUpdate = useCallback(
    async (interactive: boolean) => {
      setUpdateState("Checking…");
      try {
        const u = await checkForAmyUpdate();
        if (!u) {
          setUpdateState(`Up to date (checked ${formatWhen(new Date())})`);
          if (interactive) toast.success("A.M.Y Loader is up to date");
          return;
        }
        setUpdateState(`Version ${u.version} is available`);
        const visible = await getCurrentWindow()
          .isVisible()
          .catch(() => true);
        if (!interactive && !visible && !busyRef.current) {
          // Running hidden in the tray: nobody to ask, so update quietly.
          await notifyDesktop("Updating A.M.Y Loader", `Installing version ${u.version}. It restarts by itself.`);
          await installUpdate(u);
          return;
        }
        toast(`A.M.Y Loader ${u.version} is ready`, {
          duration: Infinity,
          action: { label: "Install & restart", onClick: () => installUpdate(u) },
        });
      } catch (e) {
        setUpdateState(`Update check failed: ${String(e)}`);
        if (interactive) toast.error(`Update check failed: ${String(e)}`);
      }
    },
    [installUpdate],
  );

  useEffect(() => {
    if (!amySettings.checkUpdates) return;
    const first = setTimeout(() => checkUpdate(false), 20_000);
    const every = setInterval(() => checkUpdate(false), UPDATE_CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [amySettings.checkUpdates, checkUpdate]);

  const nextRefresh = (() => {
    const upcoming = installs
      .map((r) => ({ r, at: refreshDueAt(r, amySettings.leadDays) }))
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (!upcoming) return null;
    const dueNow = upcoming.at.getTime() <= Date.now();
    return `${upcoming.r.app} on ${upcoming.r.deviceName} ${dueNow ? `is due (expires ${formatWhen(expiresAt(upcoming.r))})` : `from ${formatWhen(upcoming.at)}`}`;
  })();
  const targetLine =
    selectedDevice && loggedInAs
      ? `Installs to ${selectedDevice.name} with ${loggedInAs}`
      : !loggedInAs
        ? "Sign in with an Apple ID to start"
        : "Select a phone to start";

  return (
    <main className={"amy-app" + (dragOver ? " drag-over" : "")}>
      <header className="amy-header">
        <AmyMark size={42} />
        <div className="amy-brand">
          <span className="amy-kicker">A.M.Y ECOSYSTEM</span>
          <h1 className="amy-title">A.M.Y LOADER</h1>
        </div>
        <div className="amy-header-chips">
          <span className={"amy-status" + (noKeyringAvailable ? " warn" : "")}>
            <i className="amy-dot" />
            {noKeyringAvailable ? "KEYRING OFF" : "SECURE STORAGE OK"}
          </span>
          <span className="amy-status plain">v{version} · ENGINE ILOADER {UPSTREAM_ENGINE_VERSION}</span>
          <button className="amy-icon-btn" aria-label={t("app.settings")} title={t("app.settings")} onClick={() => setOpenModal("settings")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="amy-body">
        <aside className="amy-side">
          <section className="amy-section">
            <p className="amy-label">APPLE IDS</p>
            <div className="amy-panel">
              <AppleID loggedInAs={loggedInAs} setLoggedInAs={setLoggedInAs} noKeyringAvailable={noKeyringAvailable} />
            </div>
          </section>

          <section className="amy-section">
            <button className="amy-label amy-collapser" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((v) => !v)}>
              ADVANCED <span aria-hidden="true">{advancedOpen ? "▾" : "▸"}</span>
            </button>
            {advancedOpen && (
              <div className="amy-advanced">
                <p className="amy-sublabel">Installers</p>
                <button className="amy-list-btn" onClick={() => runInstaller(installSideStoreOperation, false, false)}>{t("app.sidestore_stable")}</button>
                <button className="amy-list-btn" onClick={() => runInstaller(installSideStoreOperation, true, false)}>{t("app.sidestore_nightly")}</button>
                <button className="amy-list-btn" onClick={() => runInstaller(installLiveContainerOperation, false, true)}>{t("app.livecontainer_sidestore_stable")}</button>
                <button className="amy-list-btn" onClick={() => runInstaller(installLiveContainerOperation, true, true)}>{t("app.livecontainer_sidestore_nightly")}</button>
                <p className="amy-sublabel">Tools</p>
                <button className="amy-list-btn" onClick={() => setOpenModal("autorefresh")}>
                  Auto-refresh, alerts &amp; updates
                </button>
                <button className="amy-list-btn" onClick={() => setOpenModal("track")}>
                  Track an installed app
                </button>
                <button className="amy-list-btn" onClick={() => { if (ensuredLoggedIn()) setOpenModal("certificates"); }}>
                  {t("app.certificates")} <span aria-hidden="true">{shortcutLabel("⌘⇧C", "Ctrl+Shift+C")}</span>
                </button>
                <button className="amy-list-btn" onClick={() => { if (ensuredLoggedIn()) setOpenModal("appids"); }}>
                  {t("app.app_ids")} <span aria-hidden="true">{shortcutLabel("⌘⇧A", "Ctrl+Shift+A")}</span>
                </button>
                <button className="amy-list-btn" onClick={() => { if (ensureSelectedDevice()) setOpenModal("pairing"); }}>
                  {t("app.manage_pairing_file")} <span aria-hidden="true">{shortcutLabel("⌘P", "Ctrl+P")}</span>
                </button>
                <button className="amy-list-btn" onClick={() => setOpenModal("settings")}>
                  {t("app.settings")} · logs
                </button>
              </div>
            )}
          </section>

          <button className="amy-credit" onClick={() => openUrl(UPSTREAM_URL).catch(() => {})}>
            Built on iloader by nab138 (MIT). Not affiliated with iloader.
          </button>
        </aside>

        <section className="amy-main">
          <section className="amy-section">
            <div className="amy-section-head">
              <p className="amy-label">PHONES</p>
              <span className="amy-hint">
                {selectedDevice ? `${selectedDevice.name} selected` : t("app.select_device")} · {shortcutLabel("⌘R", "Ctrl+R")} to refresh
              </span>
            </div>
            <div className="amy-panel">
              <Device
                selectedDevice={selectedDevice}
                setSelectedDevice={setSelectedDevice}
                registerRefresh={(fn) => {
                  refreshDevicesRef.current = fn ?? null;
                }}
                onDevicesChange={handleDevices}
                accountFor={(udid) => deviceAccounts[udid]}
                loggedInAs={loggedInAs}
                onSwitchAccount={switchAccount}
              />
            </div>
          </section>

          <section className="amy-section">
            <div className="amy-section-head">
              <p className="amy-label">THIS WEEK</p>
              <span className="amy-hint">
                Bars show how long each app stays signed · ↻ re-signs it now ·{" "}
                <button className="amy-link-btn" onClick={() => setOpenModal("track")}>
                  Track an installed app
                </button>
              </span>
            </div>
            <div className="amy-panel">
              <Timeline
                installs={installs}
                connected={connected}
                selectedUdid={selectedDevice?.udid ?? null}
                busy={busy}
                leadDays={amySettings.leadDays}
                autoRefreshOn={amySettings.autoRefresh}
                onResign={resign}
                onForget={forget}
              />
            </div>
          </section>

          <section className="amy-section">
            <div className="amy-section-head">
              <p className="amy-label">LIBRARY</p>
              <span className="amy-hint">Saved copies of your apps · A.M.Y checks their update sources every 6 hours</span>
            </div>
            <div className="amy-panel">
              <LibraryPanel
                apps={library}
                busy={busy}
                checking={libraryChecking}
                installedOn={installedOn}
                onInstall={(app) => installIpa(app.versions[0].path)}
                onCheck={(id) => runLibraryCheck(id, true)}
                onChanged={reloadLibrary}
                onImport={chooseIpa}
              />
            </div>
          </section>

          <section className={"amy-drop" + (dragOver ? " active" : "")}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M12 16V4M7 9l5-5 5 5" />
              <path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
            </svg>
            <div className="amy-drop-text">
              <strong>{dragOver ? "Release to add" : "Drop an .ipa (or a .zip with one inside) anywhere on this window"}</strong>
              <span>{targetLine}</span>
            </div>
            <button className="amy-primary-btn" onClick={chooseIpa} disabled={busy}>
              Choose file <span aria-hidden="true">{shortcutLabel("⌘O", "Ctrl+O")}</span>
            </button>
          </section>

          <button className={"amy-phase2" + (amySettings.autoRefresh ? " on" : "")} onClick={() => setOpenModal("autorefresh")}>
            <span className="amy-phase2-tag">AUTO-REFRESH {amySettings.autoRefresh ? "ON" : "OFF"}</span>
            <span className="amy-phase2-text">
              {auto.status.running
                ? auto.status.step ?? "Working…"
                : !amySettings.autoRefresh
                  ? "Apps won't be re-signed automatically. Click to turn it on."
                  : nextRefresh
                    ? `Next: ${nextRefresh}`
                    : "Nothing tracked yet. Install an app here, or track one you've already installed."}
            </span>
            <span className={"amy-dot" + (auto.status.running ? " busy" : "")} aria-hidden="true" />
            <span className="amy-phase2-more">Settings ›</span>
          </button>

          {operationState && <OperationView operationState={operationState} closeMenu={() => setOperationState(null)} />}
          <InstallDock />
        </section>
      </div>

      <Modal isOpen={openModal === "certificates"} close={() => setOpenModal(null)}>
        <Certificates />
      </Modal>
      <Modal isOpen={openModal === "appids"} close={() => setOpenModal(null)}>
        <AppIds />
      </Modal>
      <Modal isOpen={openModal === "pairing"} close={() => setOpenModal(null)}>
        <Pairing />
      </Modal>
      <Modal isOpen={openModal === "autorefresh"} close={() => setOpenModal(null)}>
        <AutoRefreshPanel
          installs={installs}
          status={auto.status}
          runPass={auto.runPass}
          onSettingsChange={setAmySettings}
          version={version}
          updateState={updateState}
          onCheckUpdate={() => checkUpdate(true)}
        />
      </Modal>
      <Modal isOpen={openModal === "track"} close={() => setOpenModal(null)}>
        <TrackModal
          connected={connected}
          installs={installs}
          loggedInAs={loggedInAs}
          deviceAccounts={deviceAccounts}
          onDone={() => {
            setOpenModal(null);
            reloadHistory();
          }}
        />
      </Modal>
      <Modal isOpen={openModal === "settings"} close={() => setOpenModal(null)}>
        <h2 style={{ marginTop: 0 }}>{t("app.settings")}</h2>
        <Settings
          ensureSelectedDevice={ensureSelectedDevice}
          setSelectedDevice={setSelectedDevice}
          platform={platform}
          shortcutLabel={shortcutLabel}
          checkKeyring={checkKeyring}
        />
      </Modal>
    </main>
  );
}

export default App;
