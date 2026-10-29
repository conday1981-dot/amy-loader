// Auto-refresh settings, phone alerts, updates and the activity log.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  AmySettings,
  InstallRecord,
  LogEntry,
  clearLog,
  expiresAt,
  formatWhen,
  getLog,
  getSettings,
  refreshDueAt,
  saveSettings,
} from "./history";
import { pushToPhone, randomTopic, setBackground } from "./native";
import type { AutoRefreshStatus, PassResult, RefreshReason } from "./autorefresh";

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={"amy-switch" + (on ? " on" : "")} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export function AutoRefreshPanel({
  installs,
  status,
  runPass,
  onSettingsChange,
  version,
  updateState,
  onCheckUpdate,
}: {
  installs: InstallRecord[];
  status: AutoRefreshStatus;
  runPass: (r: RefreshReason) => Promise<PassResult>;
  onSettingsChange: (s: AmySettings) => void;
  version: string;
  updateState: string;
  onCheckUpdate: () => void;
}) {
  const [settings, setSettings] = useState<AmySettings | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [topicDraft, setTopicDraft] = useState("");
  const [serverDraft, setServerDraft] = useState("");
  const [testing, setTesting] = useState(false);

  const reloadLog = useCallback(() => getLog().then(setLog).catch(() => {}), []);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setTopicDraft(s.ntfyTopic);
      setServerDraft(s.ntfyServer);
    });
    reloadLog();
  }, [reloadLog]);

  // the log changes as passes run
  useEffect(() => {
    reloadLog();
  }, [status.running, status.lastRun, reloadLog]);

  const update = async (patch: Partial<AmySettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    onSettingsChange(next);
    return next;
  };

  const setBg = async (on: boolean) => {
    try {
      await setBackground(on);
      await update({ background: on });
      toast.success(on ? "A.M.Y Loader will start with Windows and keep running in the tray" : "Background mode off");
    } catch (e) {
      toast.error(`Couldn't change start-up setting: ${String(e)}`);
    }
  };

  const saveTopic = async () => {
    const next = await update({ ntfyTopic: topicDraft, ntfyServer: serverDraft });
    setTopicDraft(next.ntfyTopic);
    setServerDraft(next.ntfyServer);
    toast.success(next.ntfyTopic ? "Phone alerts saved" : "Phone alerts off");
  };

  const testPush = async () => {
    const s = await update({ ntfyTopic: topicDraft, ntfyServer: serverDraft });
    if (!s.ntfyTopic) {
      toast.error("Add a topic first");
      return;
    }
    setTesting(true);
    try {
      await pushToPhone(s, {
        title: "A.M.Y Loader test",
        message: "Phone alerts are working. You'll hear from A.M.Y Loader when apps are refreshed or need attention.",
        tags: ["satellite"],
      });
      toast.success("Sent. It should appear on your iPhone in a few seconds.");
    } catch (e) {
      toast.error(`Not sent: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setTesting(false);
    }
  };

  const run = async (reason: RefreshReason) => {
    const res = await runPass(reason);
    if (res.refreshed > 0) toast.success(res.message);
    else toast.info(res.message);
    reloadLog();
  };

  if (!settings) return <div className="amy-form">Loading…</div>;

  const upcoming = [...installs].sort((a, b) => expiresAt(a).getTime() - expiresAt(b).getTime());

  return (
    <div className="amy-form amy-ar">
      <h2>Auto-refresh</h2>

      <div className="amy-ar-row">
        <div>
          <strong>Refresh apps automatically</strong>
          <small>Re-signs each app with the Apple ID it was signed with, once its phone is on the same Wi-Fi or plugged in.</small>
        </div>
        <Toggle on={settings.autoRefresh} onChange={(v) => update({ autoRefresh: v })} label="Refresh apps automatically" />
      </div>

      <div className="amy-ar-row">
        <div>
          <strong>Start trying</strong>
          <small>Earlier gives more chances to catch a phone on Wi-Fi.</small>
        </div>
        <select value={settings.leadDays} onChange={(e) => update({ leadDays: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} day{n > 1 ? "s" : ""} before expiry
            </option>
          ))}
        </select>
      </div>

      <div className="amy-ar-row">
        <div>
          <strong>Run in the background</strong>
          <small>Starts with Windows, hidden in the tray. Closing the window keeps it running; use the tray icon's Quit to exit.</small>
        </div>
        <Toggle on={settings.background} onChange={setBg} label="Run in the background" />
      </div>

      <div className="amy-ar-status">
        <span className={"amy-dot" + (status.running ? " busy" : "")} />
        {status.running
          ? status.step ?? "Working…"
          : status.lastRun
            ? `Last check ${formatWhen(status.lastRun)}: ${status.lastResult ?? "done"}`
            : "Checks every 5 minutes while A.M.Y Loader is running."}
      </div>
      <div className="amy-form-actions">
        <button onClick={() => run("manual")} disabled={status.running}>
          Refresh due apps now
        </button>
        <button
          onClick={async () => {
            const ok = await ask("Re-sign every tracked app whose phone is connected right now, even if it isn't due?", {
              title: "A.M.Y Loader",
              kind: "info",
            });
            if (ok) run("test");
          }}
          disabled={status.running}
        >
          Re-sign everything connected (test)
        </button>
      </div>

      {upcoming.length > 0 && (
        <>
          <p className="amy-sublabel">Schedule</p>
          <ul className="amy-ar-schedule">
            {upcoming.map((r) => (
              <li key={r.id}>
                <span>
                  {r.app} <em>· {r.deviceName}</em>
                </span>
                <span>
                  {settings.autoRefresh ? `from ${formatWhen(refreshDueAt(r, settings.leadDays))}` : "manual"} · expires {formatWhen(expiresAt(r))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="amy-sublabel">Phone alerts (ntfy)</p>
      <small className="amy-form-note">
        Install the free <strong>ntfy</strong> app on your iPhone, tap <strong>+</strong>, and subscribe to the topic below. Anyone who knows the topic
        name can read the alerts, so keep the random one. Alerts name the app and phone, never your Apple ID.
      </small>
      <label className="amy-field">
        <span>Topic</span>
        <div className="amy-field-row">
          <input value={topicDraft} onChange={(e) => setTopicDraft(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} placeholder="(off)" spellCheck={false} />
          <button onClick={() => setTopicDraft(randomTopic())}>New random</button>
          <button onClick={() => navigator.clipboard.writeText(topicDraft).then(() => toast.success("Copied"))} disabled={!topicDraft}>
            Copy
          </button>
        </div>
      </label>
      <label className="amy-field">
        <span>Server</span>
        <input value={serverDraft} onChange={(e) => setServerDraft(e.target.value)} spellCheck={false} />
        <small>ntfy.sh is the free public server. A self-hosted ntfy works too.</small>
      </label>
      <div className="amy-form-actions">
        <button onClick={saveTopic}>Save</button>
        <button onClick={testPush} disabled={testing || !topicDraft}>
          {testing ? "Sending…" : "Send a test"}
        </button>
      </div>

      <p className="amy-sublabel">Updates</p>
      <div className="amy-ar-row">
        <div>
          <strong>A.M.Y Loader {version}</strong>
          <small>{updateState}</small>
        </div>
        <button onClick={onCheckUpdate}>Check now</button>
      </div>
      <div className="amy-ar-row">
        <div>
          <strong>Check for updates automatically</strong>
          <small>On start and twice a day. Updates are signed; a download that doesn't match A.M.Y's key is refused.</small>
        </div>
        <Toggle on={settings.checkUpdates} onChange={(v) => update({ checkUpdates: v })} label="Check for updates automatically" />
      </div>

      <div className="amy-section-head">
        <p className="amy-sublabel">Activity</p>
        <button
          className="amy-link-btn"
          onClick={async () => {
            await clearLog();
            reloadLog();
          }}
          disabled={!log.length}
        >
          Clear
        </button>
      </div>
      <ul className="amy-ar-log">
        {log.length === 0 && <li className="info">Nothing yet.</li>}
        {log.slice(0, 80).map((l, i) => (
          <li key={l.at + i} className={l.level}>
            <time>{formatWhen(new Date(l.at))}</time> {l.msg}
          </li>
        ))}
      </ul>
    </div>
  );
}
