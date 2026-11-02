// A.M.Y Loader — app library bridge (Rust side: src-tauri/src/amy_library.rs).
//
// Every .ipa A.M.Y Loader installs is first saved into its own library folder,
// so re-signing never fails because a file was moved or deleted, and each app
// can have an update source that A.M.Y checks on a timer.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type LibraryVersion = {
  version: string;
  build: string;
  path: string;
  size: number;
  addedAt: string;
  origin: "imported" | "github" | "actions" | "altstore" | "url";
};

export type UpdateSource =
  | { kind: "github"; repo: string; asset: string | null; prerelease: boolean }
  | { kind: "actions"; repo: string; workflow: string; branch: string; artifact: string | null }
  | { kind: "altstore"; url: string }
  | { kind: "url"; url: string };

export type LibraryApp = {
  bundleId: string;
  name: string;
  minOs: string | null;
  /** Newest first. */
  versions: LibraryVersion[];
  source: UpdateSource | null;
  autoInstall: boolean;
  lastChecked: string | null;
  lastResult: string | null;
  remoteMarker: string | null;
};

export type ImportResult = { app: LibraryApp; version: LibraryVersion; newest: boolean };

export type CheckResult = {
  bundleId: string;
  name: string;
  status: "updated" | "current" | "no_source" | "error";
  message: string;
  version: string | null;
  path: string | null;
};

export type LibraryProgress = {
  bundleId: string;
  phase: "check" | "download" | "verify" | "idle";
  label: string;
  bytesDone: number;
  bytesTotal: number;
};

export const listLibrary = () => invoke<LibraryApp[]>("amy_library_list");
export const importToLibrary = (path: string) => invoke<ImportResult>("amy_library_import", { path });
export const removeFromLibrary = (bundleId: string) => invoke<void>("amy_library_remove", { bundleId });
export const setLibrarySource = (bundleId: string, source: UpdateSource | null, autoInstall: boolean) =>
  invoke<LibraryApp>("amy_library_set_source", { bundleId, source, autoInstall });
export const checkLibrary = (bundleId?: string) => invoke<CheckResult[]>("amy_library_check", { bundleId: bundleId ?? null });
export const libraryFolder = () => invoke<string>("amy_library_folder");
export const setGithubToken = (token: string | null) => invoke<boolean>("amy_github_token_set", { token });
export const hasGithubToken = () => invoke<boolean>("amy_github_token_present");

export function describeSource(s: UpdateSource | null): string {
  if (!s) return "No update source";
  switch (s.kind) {
    case "github":
      return `GitHub releases · ${s.repo}${s.prerelease ? " (incl. pre-releases)" : ""}`;
    case "actions":
      return `GitHub Actions · ${s.repo} · ${s.workflow}@${s.branch}`;
    case "altstore":
      return `AltStore/SideStore source · ${hostOf(s.url)}`;
    case "url":
      return `Direct link · ${hostOf(s.url)}`;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Accepts "owner/repo" or a github.com URL; returns "owner/repo" or null. */
export function parseRepo(input: string): string | null {
  const s = input.trim().replace(/\.git$/, "");
  const m = s.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/.*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Live download/check progress per app. */
export function useLibraryProgress(): Record<string, LibraryProgress> {
  const [state, setState] = useState<Record<string, LibraryProgress>>({});
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<LibraryProgress>("amy://library-progress", (e) => {
      setState((s) => ({ ...s, [e.payload.bundleId]: e.payload }));
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return state;
}
