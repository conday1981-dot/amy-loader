// A.M.Y Loader — live install progress and time-remaining estimates.
//
// The Rust side (src-tauri/src/amy_install.rs) emits `amy://install-progress`
// with the stage (connect → sign → upload → install → done), progress within
// the stage and bytes sent. This module turns that into "about 40 s left":
//
//  - upload: measured throughput (bytes/s) from this job
//  - other stages: linear extrapolation once a stage is underway, blended with
//    how long the same stage took on previous installs
//  - stages still to come: learned averages (saved in amy.json), so the very
//    first estimate is already reasonable and it gets better every install.
import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load, Store } from "@tauri-apps/plugin-store";

export type Stage = "connect" | "sign" | "upload" | "install" | "done";
export const STAGES: { id: Exclude<Stage, "done">; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "sign", label: "Sign" },
  { id: "upload", label: "Upload" },
  { id: "install", label: "Install" },
];

type ProgressEvent = {
  jobId: string;
  stage: Stage;
  label: string;
  overall: number;
  stageProgress: number;
  bytesDone: number;
  bytesTotal: number;
};

export type JobMeta = {
  app: string;
  version?: string;
  phone: string;
  /** "USB" | "Network" | "Unknown" */
  connection: string;
  /** Size of the .ipa (compressed); used before the signed size is known. */
  ipaBytes: number;
  /** Shown as "Auto-refresh" / "Update" / "Install". */
  kind: "install" | "refresh" | "update";
};

export type JobState = JobMeta & {
  id: string;
  startedAt: number;
  stage: Stage;
  label: string;
  overall: number;
  stageProgress: number;
  bytesDone: number;
  bytesTotal: number;
  stageStartedAt: number;
  uploadStartedAt: number | null;
  /** Smoothed seconds remaining; null while still calculating. */
  etaSeconds: number | null;
  /** Upload speed in bytes/s, when known. */
  rate: number | null;
  finishedAt: number | null;
  failed: string | null;
};

// ── learned timings ─────────────────────────────────────────────────────────

type Timings = {
  connectMs: number;
  signMs: number;
  installMs: number;
  usbBps: number;
  wifiBps: number;
  /** signed app size ÷ .ipa size */
  expandRatio: number;
  samples: number;
};

const DEFAULT_TIMINGS: Timings = {
  connectMs: 5_000,
  signMs: 18_000,
  installMs: 12_000,
  usbBps: 15_000_000,
  wifiBps: 3_500_000,
  expandRatio: 2.2,
  samples: 0,
};

let storePromise: Promise<Store> | null = null;
function store() {
  if (!storePromise) storePromise = load("amy.json");
  return storePromise;
}

let timings: Timings = DEFAULT_TIMINGS;
store()
  .then((s) => s.get<Timings>("timings"))
  .then((t) => {
    if (t) timings = { ...DEFAULT_TIMINGS, ...t };
  })
  .catch(() => {});

function blend(old: number, sample: number, samples: number) {
  // first few samples count more, then a steady moving average
  const alpha = samples < 3 ? 0.6 : 0.3;
  return old * (1 - alpha) + sample * alpha;
}

async function learn(job: JobState, stageDurations: Partial<Record<Stage, number>>) {
  const t = { ...timings };
  if (stageDurations.connect) t.connectMs = blend(t.connectMs, stageDurations.connect, t.samples);
  if (stageDurations.sign) t.signMs = blend(t.signMs, stageDurations.sign, t.samples);
  if (stageDurations.install) t.installMs = blend(t.installMs, stageDurations.install, t.samples);
  if (stageDurations.upload && job.bytesTotal > 0) {
    const bps = job.bytesTotal / (stageDurations.upload / 1000);
    if (job.connection === "USB") t.usbBps = blend(t.usbBps, bps, t.samples);
    else t.wifiBps = blend(t.wifiBps, bps, t.samples);
  }
  if (job.ipaBytes > 0 && job.bytesTotal > 0) t.expandRatio = blend(t.expandRatio, job.bytesTotal / job.ipaBytes, t.samples);
  t.samples += 1;
  timings = t;
  try {
    const s = await store();
    await s.set("timings", t);
    await s.save();
  } catch {
    /* estimates just stay less accurate */
  }
}

// ── estimator ───────────────────────────────────────────────────────────────

function expectedMs(stage: Stage, job: JobState): number {
  const bps = job.connection === "USB" ? timings.usbBps : timings.wifiBps;
  switch (stage) {
    case "connect":
      return timings.connectMs;
    case "sign":
      return timings.signMs;
    case "upload": {
      const bytes = job.bytesTotal || job.ipaBytes * timings.expandRatio;
      return (bytes / Math.max(bps, 1)) * 1000;
    }
    case "install":
      return timings.installMs;
    default:
      return 0;
  }
}

function rawRemainingMs(job: JobState, now: number): number | null {
  if (job.stage === "done") return 0;
  const inStage = now - job.stageStartedAt;
  let current: number;
  if (job.stage === "upload" && job.uploadStartedAt && job.bytesDone > 0 && now - job.uploadStartedAt > 1200) {
    const rate = job.bytesDone / ((now - job.uploadStartedAt) / 1000);
    current = ((job.bytesTotal - job.bytesDone) / Math.max(rate, 1)) * 1000;
  } else {
    const expected = expectedMs(job.stage, job);
    const p = job.stageProgress;
    const fromHistory = Math.max(expected - inStage, 1000);
    if (p > 0.12 && inStage > 800) {
      const linear = (inStage * (1 - p)) / p;
      current = 0.6 * linear + 0.4 * fromHistory;
    } else {
      current = fromHistory;
    }
  }
  const order: Stage[] = ["connect", "sign", "upload", "install"];
  const later = order.slice(order.indexOf(job.stage) + 1).reduce((sum, s) => sum + expectedMs(s, job), 0);
  return current + later;
}

// ── job store (one global list, React subscribes) ──────────────────────────

let jobs: JobState[] = [];
const listeners = new Set<() => void>();
const stageMarks = new Map<string, Partial<Record<Stage, number>>>();

function emit() {
  jobs = [...jobs];
  listeners.forEach((l) => l());
}

function update(id: string, patch: (j: JobState) => JobState) {
  const i = jobs.findIndex((j) => j.id === id);
  if (i === -1) return;
  jobs[i] = patch(jobs[i]);
  emit();
}

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function beginJob(id: string, meta: JobMeta) {
  const now = Date.now();
  jobs = jobs.filter((j) => !j.finishedAt); // drop finished jobs from the list
  jobs.push({
    ...meta,
    id,
    startedAt: now,
    stage: "connect",
    label: `Connecting to ${meta.phone}`,
    overall: 0,
    stageProgress: 0,
    bytesDone: 0,
    bytesTotal: 0,
    stageStartedAt: now,
    uploadStartedAt: null,
    etaSeconds: null,
    rate: null,
    finishedAt: null,
    failed: null,
  });
  stageMarks.set(id, { connect: now });
  emit();
}

export function endJob(id: string, error?: string) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  const now = Date.now();
  if (!error) {
    const marks = stageMarks.get(id) ?? {};
    const order: Stage[] = ["connect", "sign", "upload", "install", "done"];
    const durations: Partial<Record<Stage, number>> = {};
    marks.done = marks.done ?? now;
    for (let i = 0; i < order.length - 1; i++) {
      const a = marks[order[i]];
      const b = marks[order[i + 1]];
      if (a && b && b > a) durations[order[i]] = b - a;
    }
    learn(job, durations);
  }
  stageMarks.delete(id);
  update(id, (j) => ({
    ...j,
    stage: error ? j.stage : "done",
    label: error ? "Stopped" : "Installed",
    overall: error ? j.overall : 1,
    stageProgress: error ? j.stageProgress : 1,
    etaSeconds: 0,
    finishedAt: now,
    failed: error ?? null,
  }));
}

export function dismissJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

let started = false;
/** Start listening for progress from Rust (once). */
export function startProgressListener() {
  if (started) return;
  started = true;
  listen<ProgressEvent>("amy://install-progress", (event) => {
    const e = event.payload;
    const now = Date.now();
    update(e.jobId, (j) => {
      const stageChanged = e.stage !== j.stage;
      if (stageChanged) {
        const marks = stageMarks.get(j.id) ?? {};
        if (!marks[e.stage]) marks[e.stage] = now;
        stageMarks.set(j.id, marks);
      }
      const uploadStartedAt = e.stage === "upload" ? (j.uploadStartedAt ?? now) : j.uploadStartedAt;
      const rate =
        e.stage === "upload" && uploadStartedAt && e.bytesDone > 0 && now - uploadStartedAt > 500
          ? e.bytesDone / ((now - uploadStartedAt) / 1000)
          : j.rate;
      return {
        ...j,
        stage: e.stage,
        label: e.label,
        // the bar never moves backwards
        overall: Math.max(j.overall, e.overall),
        stageProgress: e.stageProgress,
        bytesDone: e.bytesDone,
        bytesTotal: e.bytesTotal || j.bytesTotal,
        stageStartedAt: stageChanged ? now : j.stageStartedAt,
        uploadStartedAt,
        rate,
      };
    });
  }).catch((e) => console.error("Progress events unavailable", e));

  // Re-estimate twice a second so the countdown keeps moving between events.
  setInterval(() => {
    if (!jobs.some((j) => !j.finishedAt)) return;
    const now = Date.now();
    jobs = jobs.map((j) => {
      if (j.finishedAt) return j;
      const raw = rawRemainingMs(j, now);
      if (raw === null) return j;
      const target = raw / 1000;
      if (now - j.startedAt < 1500 || j.etaSeconds === null) return { ...j, etaSeconds: now - j.startedAt < 1500 ? null : target };
      // smooth: count down steadily, drift towards the new estimate
      const counted = Math.max(j.etaSeconds - 0.5, 0);
      return { ...j, etaSeconds: counted * 0.7 + target * 0.3 };
    });
    listeners.forEach((l) => l());
  }, 500);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useJobs(): JobState[] {
  return useSyncExternalStore(subscribe, () => jobs);
}

// ── formatting ─────────────────────────────────────────────────────────────

export function formatEta(s: number | null): string {
  if (s === null) return "Calculating time left…";
  if (s < 5) return "A few seconds left";
  if (s < 60) return `About ${Math.round(s / 5) * 5 || 5} s left`;
  const m = Math.floor(s / 60);
  const rest = Math.round((s - m * 60) / 10) * 10;
  return rest >= 60 ? `About ${m + 1} min left` : rest ? `About ${m} min ${rest} s left` : `About ${m} min left`;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Re-render every second (for elapsed timers). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export type IpaInfo = { bundleId: string; name: string; version: string; build: string; minOs?: string | null; size: number };

/** Name, version and bundle id read from inside the .ipa. */
export function readIpaInfo(path: string): Promise<IpaInfo> {
  return invoke<IpaInfo>("amy_ipa_info", { path });
}
