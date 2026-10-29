// "Track an installed app": tell A.M.Y Loader about an app that is already on
// a phone (installed with iloader, Sideloadly or an earlier A.M.Y Loader), so
// the timeline and auto-refresh know about it without reinstalling.
import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import type { DeviceInfo } from "../Device";
import { InstallRecord, appNameFromPath, deviceKey, recordInstall } from "./history";

type PhoneOption = { key: string; udid: string; name: string; connected: boolean };

/** yyyy-MM-ddTHH:mm in local time, for <input type="datetime-local">. */
function localInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TrackModal({
  connected,
  installs,
  loggedInAs,
  deviceAccounts,
  onDone,
}: {
  connected: DeviceInfo[];
  installs: InstallRecord[];
  loggedInAs: string | null;
  deviceAccounts: Record<string, string>;
  onDone: () => void;
}) {
  const [ipaPath, setIpaPath] = useState("");
  const [app, setApp] = useState("");
  const [phoneKey, setPhoneKey] = useState("");
  const [appleId, setAppleId] = useState(loggedInAs ?? "");
  const [ids, setIds] = useState<string[]>([]);
  const [signedAt, setSignedAt] = useState(localInputValue(new Date()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load("data.json")
      .then((s) => s.get<string[]>("ids"))
      .then((v) => setIds(v ?? []))
      .catch(() => setIds([]));
  }, []);

  const phones = useMemo<PhoneOption[]>(() => {
    const out = new Map<string, PhoneOption>();
    for (const d of connected) out.set(d.udid, { key: d.udid, udid: d.udid, name: d.name, connected: true });
    for (const r of installs) {
      const key = deviceKey(r);
      if (out.has(key) || [...out.values()].some((p) => p.name === r.deviceName && !r.deviceUdid)) continue;
      out.set(key, { key, udid: r.deviceUdid, name: r.deviceName, connected: false });
    }
    return [...out.values()];
  }, [connected, installs]);

  useEffect(() => {
    if (!phoneKey && phones.length) setPhoneKey(phones[0].key);
  }, [phones, phoneKey]);

  // Default the Apple ID to the one that phone usually uses.
  useEffect(() => {
    const p = phones.find((x) => x.key === phoneKey);
    const usual = p?.udid ? deviceAccounts[p.udid] : undefined;
    if (usual) setAppleId(usual);
  }, [phoneKey, phones, deviceAccounts]);

  const allIds = useMemo(() => [...new Set([...(loggedInAs ? [loggedInAs] : []), ...ids])], [ids, loggedInAs]);
  const phone = phones.find((p) => p.key === phoneKey);
  const when = new Date(signedAt);
  const whenValid = !Number.isNaN(when.getTime()) && when.getTime() <= Date.now() + 60_000;
  const canSave = !!ipaPath && !!app.trim() && !!phone && !!appleId && whenValid && !saving;

  const choose = async () => {
    const path = await openFileDialog({ multiple: false, filters: [{ name: ".ipa files", extensions: ["ipa"] }] });
    if (!path) return;
    setIpaPath(path as string);
    setApp(appNameFromPath(path as string));
  };

  const setDaysAgo = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    setSignedAt(localInputValue(d));
  };

  const save = async () => {
    if (!canSave || !phone) return;
    setSaving(true);
    try {
      await recordInstall({
        app: app.trim(),
        ipaPath,
        deviceUdid: phone.udid,
        deviceName: phone.name,
        appleId,
        signedAt: when.toISOString(),
      });
      toast.success(`Tracking ${app.trim()} on ${phone.name}`);
      onDone();
    } catch (e) {
      toast.error(`Couldn't save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="amy-form">
      <h2>Track an installed app</h2>
      <p className="amy-form-note">
        For an app that's already on a phone. Nothing is installed now. A.M.Y Loader adds it to the timeline and refreshes it
        automatically before it expires, using the same <code>.ipa</code>.
      </p>

      <label className="amy-field">
        <span>The .ipa you installed</span>
        <div className="amy-field-row">
          <input readOnly value={ipaPath} placeholder="Choose the .ipa file…" title={ipaPath} />
          <button onClick={choose}>Choose…</button>
        </div>
        <small>Keep it in the same place; auto-refresh re-signs this file.</small>
      </label>

      <label className="amy-field">
        <span>App name</span>
        <input value={app} onChange={(e) => setApp(e.target.value)} placeholder="e.g. Spotify" />
      </label>

      <label className="amy-field">
        <span>Phone</span>
        {phones.length ? (
          <select value={phoneKey} onChange={(e) => setPhoneKey(e.target.value)}>
            {phones.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
                {p.connected ? "" : " (not connected)"}
              </option>
            ))}
          </select>
        ) : (
          <small className="amy-warn-text">Connect the phone first (USB or Wi-Fi) so A.M.Y Loader can identify it.</small>
        )}
      </label>

      <label className="amy-field">
        <span>Apple ID it was signed with</span>
        <select value={appleId} onChange={(e) => setAppleId(e.target.value)}>
          {!allIds.includes(appleId) && <option value={appleId}>{appleId || "Choose…"}</option>}
          {allIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <small>Auto-refresh signs in with this saved login, so it must be one of your saved Apple IDs.</small>
      </label>

      <label className="amy-field">
        <span>When it was installed</span>
        <div className="amy-field-row">
          <input type="datetime-local" value={signedAt} max={localInputValue(new Date())} onChange={(e) => setSignedAt(e.target.value)} />
          <button onClick={() => setDaysAgo(0)}>Today</button>
          <button onClick={() => setDaysAgo(1)}>Yesterday</button>
        </div>
        {!whenValid && <small className="amy-warn-text">Pick a time in the past.</small>}
        {whenValid && (
          <small>
            Expires about {new Date(when.getTime() + 7 * 86400000).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" })}. If unsure, pick
            the earlier time: refreshing early is harmless.
          </small>
        )}
      </label>

      <div className="amy-form-actions">
        <button className="amy-primary-btn" disabled={!canSave} onClick={save}>
          {saving ? "Saving…" : "Track this app"}
        </button>
      </div>
    </div>
  );
}
