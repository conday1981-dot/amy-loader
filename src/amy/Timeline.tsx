import { useMemo } from "react";
import { InstallRecord, deviceKey, expiresAt, daysLeftLabel, formatWhen, refreshDueAt, urgency } from "./history";
import type { DeviceInfo } from "../Device";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 7;

type Props = {
  installs: InstallRecord[];
  connected: DeviceInfo[];
  selectedUdid: string | null;
  busy: boolean;
  /** Auto-refresh setting: start trying this many days before expiry. */
  leadDays: number;
  autoRefreshOn: boolean;
  onResign: (rec: InstallRecord) => void;
  onForget: (rec: InstallRecord) => void;
};

function startOfToday(now: Date) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function Timeline({ installs, connected, selectedUdid, busy, leadDays, autoRefreshOn, onResign, onForget }: Props) {
  const now = new Date();
  const weekStart = startOfToday(now);
  const weekEnd = new Date(weekStart.getTime() + DAYS * DAY_MS);
  const span = weekEnd.getTime() - weekStart.getTime();
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - weekStart.getTime()) / span) * 100));

  const days = useMemo(
    () =>
      Array.from({ length: DAYS }, (_, i) => {
        const d = new Date(weekStart.getTime() + i * DAY_MS);
        return {
          key: d.toDateString(),
          label: d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase(),
          num: d.getDate(),
          today: i === 0,
          friday: d.getDay() === 5,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekStart.getTime()],
  );

  // One lane per phone that has installs (plus connected phones with none yet).
  const lanes = useMemo(() => {
    type Lane = { key: string; udid: string; name: string; recs: InstallRecord[] };
    const map = new Map<string, Lane>();
    for (const r of installs) {
      const key = deviceKey(r);
      if (!map.has(key)) map.set(key, { key, udid: r.deviceUdid, name: r.deviceName, recs: [] });
      map.get(key)!.recs.push(r);
    }
    for (const d of connected) {
      if (map.has(d.udid)) continue;
      // records saved before the phone's UDID was known share its name
      const byName = map.get(`name:${d.name}`);
      if (byName && !byName.udid) byName.udid = d.udid;
      else map.set(d.udid, { key: d.udid, udid: d.udid, name: d.name, recs: [] });
    }
    for (const l of map.values()) l.recs.sort((a, b) => expiresAt(a).getTime() - expiresAt(b).getTime());
    return [...map.values()];
  }, [installs, connected]);

  const nowPct = pct(now.getTime());

  return (
    <div className="amy-timeline">
      <div className="amy-tl-head">
        <span className="amy-tl-lane-label" />
        <div className="amy-tl-days">
          {days.map((d) => (
            <span key={d.key} className={"amy-tl-day" + (d.today ? " today" : "") + (d.friday ? " friday" : "")}>
              {d.today ? "TODAY" : d.label} <b>{d.num}</b>
            </span>
          ))}
        </div>
      </div>

      {lanes.length === 0 && (
        <div className="amy-tl-empty">
          Nothing tracked yet. Apps you install from A.M.Y Loader appear here with their 7-day countdown. Already installed one? Use “Track an installed app”.
        </div>
      )}

      {lanes.map((lane) => {
        const dev = connected.find((d) => (lane.udid ? d.udid === lane.udid : d.name === lane.name));
        return (
          <div key={lane.key} className={"amy-tl-lane" + (lane.udid && lane.udid === selectedUdid ? " selected" : "")}>
            <div className="amy-tl-lane-label">
              <span className="amy-tl-phone">{lane.name}</span>
              <span className={"amy-chip " + (dev ? (dev.connectionType === "Network" ? "wifi" : "usb") : "offline")}>
                {dev ? (dev.connectionType === "Network" ? "WI-FI" : "USB") : "NOT CONNECTED"}
              </span>
            </div>
            <div className="amy-tl-track">
              {days.map((d, i) => (
                <span key={d.key} className={"amy-tl-gridline" + (d.friday ? " friday" : "")} style={{ left: `${(i / DAYS) * 100}%` }} />
              ))}
              <span className="amy-tl-now" style={{ left: `${nowPct}%` }} aria-hidden="true" />
              {lane.recs.length === 0 && <span className="amy-tl-lane-empty">No apps tracked on this phone yet</span>}
              {lane.recs.map((r, idx) => {
                const start = Math.max(new Date(r.signedAt).getTime(), weekStart.getTime());
                const end = expiresAt(r).getTime();
                const left = pct(start);
                const width = Math.max(pct(end) - left, 6);
                const refreshAt = refreshDueAt(r, leadDays).getTime();
                const showDiamond = autoRefreshOn && refreshAt > now.getTime() && refreshAt < weekEnd.getTime();
                const u = urgency(r, now);
                return (
                  <div
                    key={r.id}
                    className={"amy-tl-bar " + u}
                    style={{ left: `${left}%`, width: `${width}%`, top: `${6 + idx * 34}px` }}
                    title={`${r.app} — signed ${formatWhen(new Date(r.signedAt))} with ${r.appleId}, expires ${formatWhen(expiresAt(r))}${autoRefreshOn ? `; auto-refresh from ${formatWhen(new Date(refreshAt))}` : ""}`}
                  >
                    {showDiamond && (
                      <span
                        className="amy-tl-diamond"
                        style={{ left: `${((refreshAt - start) / Math.max(1, end - start)) * 100}%` }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="amy-tl-bar-name">{r.app}</span>
                    <span className="amy-tl-bar-left">{daysLeftLabel(r, now)}</span>
                    <button
                      className="amy-tl-bar-btn"
                      aria-label={`Re-sign ${r.app} now`}
                      title="Re-sign now"
                      disabled={busy}
                      onClick={() => onResign(r)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" /></svg>
                    </button>
                    <button
                      className="amy-tl-bar-btn"
                      aria-label={`Stop tracking ${r.app}`}
                      title="Stop tracking"
                      disabled={busy}
                      onClick={() => onForget(r)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                );
              })}
              <span style={{ display: "block", height: `${Math.max(1, lane.recs.length) * 34 + 8}px` }} />
            </div>
          </div>
        );
      })}

      <div className="amy-tl-legend">
        <span><i className="amy-legend-sw ok" /> 4+ days</span>
        <span><i className="amy-legend-sw soon" /> 1–3 days</span>
        <span><i className="amy-legend-sw urgent" /> under a day</span>
        <span><i className="amy-legend-diamond" /> {autoRefreshOn ? `auto-refresh starts (${leadDays}d before expiry)` : "auto-refresh is off"}</span>
      </div>
    </div>
  );
}
