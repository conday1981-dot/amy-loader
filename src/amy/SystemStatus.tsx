// A.M.Y Loader: header status chip + panel. One coloured dot per service,
// with the worst one named, so "is it me or is it Apple?" is answered at a glance.
import { useEffect, useRef, useState } from "react";
import { SystemStatus, StatusItem, ago, stateWord, worst } from "./status";

function headline(items: StatusItem[]): string {
  const bad = items.filter((i) => i.state !== "ok" && i.state !== "unknown");
  if (bad.length === 0) return "ALL SYSTEMS GO";
  const top = [...bad].sort((a, b) => rank(b) - rank(a))[0];
  const more = bad.length > 1 ? ` +${bad.length - 1}` : "";
  return `${top.label.toUpperCase()} ${stateWord(top.state)}${more}`;
}

function rank(i: StatusItem): number {
  return { ok: 0, unknown: 1, warn: 2, down: 3, blocked: 4 }[i.state];
}

export function SystemStatusChip({ status }: { status: SystemStatus }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const overall = worst(status.items.filter((i) => i.state !== "unknown"));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = status.checkedAtMs === null && status.checking ? "CHECKING…" : headline(status.items);

  return (
    <div className="amy-sys" ref={wrapRef}>
      <button
        className={`amy-status amy-sys-chip s-${overall}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="What's working, down or blocked"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="amy-sys-dots" aria-hidden="true">
          {status.items.map((i) => (
            <i key={i.id} className={`amy-sys-dot s-${i.state}` + (status.checking ? " busy" : "")} />
          ))}
        </span>
        {label}
      </button>

      {open && (
        <div className="amy-sys-panel" role="dialog" aria-label="System status">
          <div className="amy-sys-head">
            <span className="amy-label">SYSTEM STATUS</span>
            <span className="amy-hint">
              {status.checking ? "Checking…" : status.checkedAtMs ? `Checked ${ago(status.checkedAtMs)}` : ""}
            </span>
            <button className="amy-sys-recheck" onClick={status.recheck} disabled={status.checking}>
              {status.checking ? "Checking…" : "Check now"}
            </button>
          </div>
          <ul className="amy-sys-list">
            {status.items.map((i) => (
              <li key={i.id} className={`amy-sys-row s-${i.state}`}>
                <i className={`amy-sys-dot s-${i.state}`} aria-hidden="true" />
                <div className="amy-sys-text">
                  <div className="amy-sys-line">
                    <strong>{i.label}</strong>
                    <span className="amy-sys-word">{stateWord(i.state)}</span>
                  </div>
                  <p className="amy-sys-summary">
                    {i.summary}
                    {i.atMs ? <span className="amy-sys-when"> · {ago(i.atMs)}</span> : null}
                  </p>
                  {i.fix && i.state !== "ok" && <p className="amy-sys-fix">→ {i.fix}</p>}
                </div>
              </li>
            ))}
          </ul>
          {status.identity && (
            <p className="amy-sys-foot">
              Sign-in identity tried first: <strong>{status.identity}</strong>. If Apple refuses it, A.M.Y switches
              identity automatically.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
