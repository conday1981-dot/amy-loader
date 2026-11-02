// A.M.Y Loader — the live install HUD.
//
// One card per running (or just-finished) job: arc-reactor ring with the
// overall percentage, the four stage chips lighting up in turn, what is
// happening right now, bytes and speed while uploading, elapsed time and an
// estimate of the time left. Shown as a dock in the corner, so it also covers
// installs started by auto-refresh or library updates while the window is up.
import { JobState, STAGES, dismissJob, formatBytes, formatElapsed, formatEta, useJobs, useTick } from "./progress";

function Ring({ value, failed, done }: { value: number; failed: boolean; done: boolean }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.round(value * 100);
  return (
    <div className={"amy-ring" + (failed ? " failed" : done ? " done" : " live")}>
      <svg viewBox="0 0 84 84" aria-hidden="true">
        <circle className="amy-ring-track" cx="42" cy="42" r={r} />
        <circle className="amy-ring-orbit" cx="42" cy="42" r={r + 6} />
        <circle
          className="amy-ring-fill"
          cx="42"
          cy="42"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
          transform="rotate(-90 42 42)"
        />
      </svg>
      <span className="amy-ring-label">{failed ? "!" : done ? "✓" : `${pct}%`}</span>
    </div>
  );
}

function JobCard({ job }: { job: JobState }) {
  useTick(1000);
  const done = job.stage === "done" && !job.failed;
  const failed = !!job.failed;
  const elapsed = (job.finishedAt ?? Date.now()) - job.startedAt;
  const stageIndex = STAGES.findIndex((s) => s.id === job.stage);
  const kind = job.kind === "refresh" ? "AUTO-REFRESH" : job.kind === "update" ? "UPDATE" : "INSTALL";

  return (
    <div className={"amy-job" + (done ? " done" : "") + (failed ? " failed" : "")} role="status" aria-live="polite">
      <Ring value={job.overall} failed={failed} done={done} />
      <div className="amy-job-body">
        <div className="amy-job-head">
          <span className="amy-job-kind">{kind}</span>
          <strong className="amy-job-title">
            {job.app}
            {job.version ? <span className="amy-job-ver"> v{job.version}</span> : null}
          </strong>
          <span className="amy-job-phone">→ {job.phone}{job.connection === "Network" ? " · Wi-Fi" : job.connection === "USB" ? " · USB" : ""}</span>
          {job.finishedAt && (
            <button className="amy-job-close" aria-label="Dismiss" onClick={() => dismissJob(job.id)}>
              ×
            </button>
          )}
        </div>

        <ol className="amy-stages">
          {STAGES.map((s, i) => {
            const state = done || i < stageIndex ? "done" : i === stageIndex ? (failed ? "failed" : "active") : "todo";
            return (
              <li key={s.id} className={"amy-stage " + state}>
                <i aria-hidden="true" />
                {s.label}
              </li>
            );
          })}
        </ol>

        <div className="amy-job-bar" aria-hidden="true">
          <div className="amy-job-bar-fill" style={{ width: `${Math.round(job.overall * 100)}%` }} />
        </div>

        <div className="amy-job-now">
          {failed ? <span className="amy-job-error">{job.failed}</span> : <span>{job.label}{done ? "" : "…"}</span>}
        </div>

        <div className="amy-job-meta">
          {job.stage === "upload" && job.bytesTotal > 0 && (
            <span>
              {formatBytes(job.bytesDone)} / {formatBytes(job.bytesTotal)}
              {job.rate ? ` · ${formatBytes(job.rate)}/s` : ""}
            </span>
          )}
          <span>{done ? `Done in ${formatElapsed(elapsed)}` : failed ? `Stopped after ${formatElapsed(elapsed)}` : `${formatElapsed(elapsed)} elapsed`}</span>
          {!done && !failed && <span className="amy-job-eta">{formatEta(job.etaSeconds)}</span>}
        </div>
      </div>
    </div>
  );
}

/** Bottom-right dock listing live installs. Finished jobs stay until dismissed or replaced. */
export function InstallDock() {
  const jobs = useJobs();
  if (jobs.length === 0) return null;
  return (
    <div className="amy-dock">
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
    </div>
  );
}
