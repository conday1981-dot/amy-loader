import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { AppleID } from "./AppleID";
import { Device, DeviceInfo } from "./Device";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  sideloadOperation,
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
  InstallRecord,
  appNameFromPath,
  forgetInstall,
  getAmyData,
  recordInstall,
} from "./amy/history";
import { UPSTREAM_ENGINE_VERSION, UPSTREAM_URL } from "./amy/meta";
import "./amy/strings";
// Loaded last so the A.M.Y theme overrides iloader's component styles.
import "./amy/amy.css";

type ModalName = null | "certificates" | "appids" | "pairing" | "settings";

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
    // iloader's checkForUpdates() is deliberately not called: it pulls nab138's
    // builds, which would replace A.M.Y Loader. A.M.Y's own update feed comes later.
    getVersion().then(setVersion).catch(() => {});
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

  /** Install (or re-sign) one .ipa on the selected phone and record it. */
  const installIpa = useCallback(
    async (path: string) => {
      if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
      const device = selectedDevice!;
      const appleId = loggedInAs!;
      try {
        await startOperation(sideloadOperation, { appPath: path });
        await recordInstall({
          app: appNameFromPath(path),
          ipaPath: path,
          deviceUuid: device.uuid,
          deviceName: device.name,
          appleId,
        });
        await reloadHistory();
      } catch (e: any) {
        console.log(e?.type);
        console.error(e?.message ?? e);
      }
    },
    [ensuredLoggedIn, ensureSelectedDevice, selectedDevice, loggedInAs, startOperation, reloadHistory],
  );

  const chooseIpa = useCallback(async () => {
    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
    const path = await openFileDialog({
      multiple: false,
      filters: [{ name: t("app.ipa_files"), extensions: ["ipa"] }],
    });
    if (!path) return;
    installIpa(path as string);
  }, [ensuredLoggedIn, ensureSelectedDevice, installIpa, t]);

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
      if (!selectedDevice || selectedDevice.uuid !== rec.deviceUuid) {
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
  const installIpaRef = useRef(installIpa);
  installIpaRef.current = installIpa;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDragOver(true);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          const ipa = p.paths.find((x) => /\.ipa$/i.test(x));
          if (!ipa) {
            toast.error("That isn't an .ipa file");
            return;
          }
          if (p.paths.length > 1) toast.message("Installing the first .ipa — drop one at a time");
          installIpaRef.current(ipa);
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

  const busy = operationState !== null;
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
                onDevicesChange={setConnected}
                accountFor={(uuid) => deviceAccounts[uuid]}
                loggedInAs={loggedInAs}
                onSwitchAccount={switchAccount}
              />
            </div>
          </section>

          <section className="amy-section">
            <div className="amy-section-head">
              <p className="amy-label">THIS WEEK</p>
              <span className="amy-hint">Bars show how long each app stays signed · ↻ re-signs it now</span>
            </div>
            <div className="amy-panel">
              <Timeline
                installs={installs}
                connected={connected}
                selectedUuid={selectedDevice?.uuid ?? null}
                busy={busy}
                onResign={resign}
                onForget={forget}
              />
            </div>
          </section>

          <section className={"amy-drop" + (dragOver ? " active" : "")}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M12 16V4M7 9l5-5 5 5" />
              <path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
            </svg>
            <div className="amy-drop-text">
              <strong>{dragOver ? "Release to install" : "Drop an .ipa anywhere on this window"}</strong>
              <span>{targetLine}</span>
            </div>
            <button className="amy-primary-btn" onClick={chooseIpa} disabled={busy}>
              Choose .ipa <span aria-hidden="true">{shortcutLabel("⌘O", "Ctrl+O")}</span>
            </button>
          </section>

          <section className="amy-phase2">
            <span className="amy-phase2-tag">AUTO-REFRESH</span>
            <span>Re-signs your apps over home Wi-Fi about 2 days before they expire. Coming in Phase 2.</span>
            <span className="amy-toggle off" aria-hidden="true"><i /></span>
          </section>

          {operationState && <OperationView operationState={operationState} closeMenu={() => setOperationState(null)} />}
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
