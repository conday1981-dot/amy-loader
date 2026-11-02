// A.M.Y Loader — LIBRARY section: every saved .ipa, its version, where its
// updates come from, and live check/download progress.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  LibraryApp,
  UpdateSource,
  describeSource,
  hasGithubToken,
  libraryFolder,
  parseRepo,
  removeFromLibrary,
  setGithubToken,
  setLibrarySource,
  useLibraryProgress,
} from "./library";
import { formatBytes } from "./progress";
import { formatWhen } from "./history";

type Props = {
  apps: LibraryApp[];
  busy: boolean;
  checking: boolean;
  /** Phones each app is tracked on (bundle id → phone names). */
  installedOn: (app: LibraryApp) => string[];
  onInstall: (app: LibraryApp) => void;
  onCheck: (bundleId?: string) => void;
  onChanged: () => void;
  onImport: () => void;
};

type Kind = "none" | UpdateSource["kind"];

function SourceEditor({ app, onSaved, onCancel }: { app: LibraryApp; onSaved: () => void; onCancel: () => void }) {
  const s = app.source;
  const [kind, setKind] = useState<Kind>(s?.kind ?? "none");
  const [repo, setRepo] = useState(s && (s.kind === "github" || s.kind === "actions") ? s.repo : "");
  const [asset, setAsset] = useState(s?.kind === "github" ? s.asset ?? "" : s?.kind === "actions" ? s.artifact ?? "" : "");
  const [prerelease, setPrerelease] = useState(s?.kind === "github" ? s.prerelease : false);
  const [workflow, setWorkflow] = useState(s?.kind === "actions" ? s.workflow : "build.yml");
  const [branch, setBranch] = useState(s?.kind === "actions" ? s.branch : "main");
  const [url, setUrl] = useState(s && (s.kind === "altstore" || s.kind === "url") ? s.url : "");
  const [autoInstall, setAutoInstall] = useState(app.autoInstall);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    let source: UpdateSource | null = null;
    if (kind === "github" || kind === "actions") {
      const r = parseRepo(repo);
      if (!r) return toast.error("Enter the repo as owner/name or a github.com link");
      source =
        kind === "github"
          ? { kind, repo: r, asset: asset.trim() || null, prerelease }
          : { kind, repo: r, workflow: workflow.trim() || "build.yml", branch: branch.trim() || "main", artifact: asset.trim() || null };
    } else if (kind === "altstore" || kind === "url") {
      if (!/^https:\/\//i.test(url.trim())) return toast.error("Enter an https:// link");
      source = { kind, url: url.trim() };
    }
    setSaving(true);
    try {
      await setLibrarySource(app.bundleId, source, autoInstall);
      toast.success(source ? `Updates for ${app.name}: ${describeSource(source)}` : `Update source removed for ${app.name}`);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="amy-lib-editor">
      <label className="amy-field">
        <span>Where do updates come from?</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="none">Nowhere (manual only)</option>
          <option value="github">GitHub releases</option>
          <option value="actions">GitHub Actions build (e.g. your own apps)</option>
          <option value="altstore">AltStore / SideStore source</option>
          <option value="url">Direct download link</option>
        </select>
      </label>

      {(kind === "github" || kind === "actions") && (
        <label className="amy-field">
          <span>Repository</span>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo or https://github.com/owner/repo" spellCheck={false} />
        </label>
      )}
      {kind === "github" && (
        <>
          <label className="amy-field">
            <span>Asset name contains (optional, when a release has several .ipa files)</span>
            <input value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="e.g. Enhanced" spellCheck={false} />
          </label>
          <label className="amy-check">
            <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} /> Include pre-releases
          </label>
        </>
      )}
      {kind === "actions" && (
        <div className="amy-field-row">
          <label className="amy-field">
            <span>Workflow file</span>
            <input value={workflow} onChange={(e) => setWorkflow(e.target.value)} spellCheck={false} />
          </label>
          <label className="amy-field">
            <span>Branch</span>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
          </label>
          <label className="amy-field">
            <span>Artifact name contains</span>
            <input value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="optional" spellCheck={false} />
          </label>
        </div>
      )}
      {(kind === "altstore" || kind === "url") && (
        <label className="amy-field">
          <span>{kind === "altstore" ? "Source URL (the JSON feed)" : "Link that always downloads the newest .ipa"}</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
        </label>
      )}
      {kind !== "none" && (
        <label className="amy-check">
          <input type="checkbox" checked={autoInstall} onChange={(e) => setAutoInstall(e.target.checked)} /> Install updates on my phones as soon as
          they download (otherwise they go on at the next re-sign)
        </label>
      )}
      <div className="amy-lib-editor-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="amy-primary-btn" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Monogram({ name }: { name: string }) {
  const letters = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return <span className="amy-lib-mono" aria-hidden="true">{letters || "?"}</span>;
}

export function LibraryPanel({ apps, busy, checking, installedOn, onInstall, onCheck, onChanged, onImport }: Props) {
  const progress = useLibraryProgress();
  const [editing, setEditing] = useState<string | null>(null);
  const [tokenSet, setTokenSet] = useState<boolean | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");

  useEffect(() => {
    hasGithubToken().then(setTokenSet).catch(() => setTokenSet(false));
  }, []);

  const saveToken = useCallback(async (value: string | null) => {
    try {
      const present = await setGithubToken(value);
      setTokenSet(present);
      setToken("");
      setTokenOpen(false);
      toast.success(present ? "GitHub token saved in Windows Credential Manager" : "GitHub token removed");
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  const remove = async (app: LibraryApp) => {
    if (!confirm(`Remove ${app.name} and its saved .ipa files from the library? Apps already on your phones stay installed.`)) return;
    try {
      await removeFromLibrary(app.bundleId);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="amy-lib">
      <div className="amy-lib-toolbar">
        <button onClick={onImport} disabled={busy}>+ Add .ipa</button>
        <button onClick={() => onCheck()} disabled={checking || !apps.some((a) => a.source)}>
          {checking ? "Checking…" : "Check all for updates"}
        </button>
        <button onClick={() => libraryFolder().then((p) => revealItemInDir(p)).catch((e) => toast.error(String(e)))}>Open folder</button>
        <button className={"amy-token" + (tokenSet ? " on" : "")} onClick={() => setTokenOpen((v) => !v)}>
          GitHub token: {tokenSet === null ? "…" : tokenSet ? "saved" : "not set"}
        </button>
      </div>

      {tokenOpen && (
        <div className="amy-lib-editor">
          <p className="amy-lib-note">
            Needed for private repos (like your own A.M.Y app builds) and GitHub Actions artifacts. Create a fine-grained token on GitHub with
            read-only <b>Contents</b> and <b>Actions</b> access to the repos you want. It's stored in Windows Credential Manager, never in a file.
          </p>
          <label className="amy-field">
            <span>Token</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" spellCheck={false} />
          </label>
          <div className="amy-lib-editor-actions">
            {tokenSet && <button onClick={() => saveToken(null)}>Remove token</button>}
            <button className="amy-primary-btn" onClick={() => saveToken(token)} disabled={!token.trim()}>
              Save token
            </button>
          </div>
        </div>
      )}

      {apps.length === 0 ? (
        <p className="amy-empty">
          No apps saved yet. Drop an .ipa (or a .zip with an .ipa inside, like a GitHub build) onto this window — A.M.Y keeps a copy here so it can
          re-sign and update it later.
        </p>
      ) : (
        <ul className="amy-lib-list">
          {apps.map((app) => {
            const current = app.versions[0];
            const p = progress[app.bundleId];
            const live = p && p.phase !== "idle";
            const phones = installedOn(app);
            return (
              <li key={app.bundleId} className={"amy-lib-item" + (live ? " live" : "")}>
                <Monogram name={app.name} />
                <div className="amy-lib-info">
                  <div className="amy-lib-line">
                    <strong>{app.name}</strong>
                    {current && (
                      <span className="amy-lib-ver">
                        v{current.version} <span className="amy-dim">({current.build})</span> · {formatBytes(current.size)}
                      </span>
                    )}
                    {app.autoInstall && app.source && <span className="amy-pill">AUTO-UPDATE</span>}
                  </div>
                  <div className="amy-lib-sub">
                    {describeSource(app.source)}
                    {phones.length > 0 && <> · on {phones.join(", ")}</>}
                  </div>
                  {live ? (
                    <div className="amy-lib-progress">
                      <span>{p.label}</span>
                      {p.phase === "download" && p.bytesTotal > 0 && (
                        <>
                          <div className="amy-job-bar">
                            <div className="amy-job-bar-fill" style={{ width: `${Math.round((p.bytesDone / p.bytesTotal) * 100)}%` }} />
                          </div>
                          <span className="amy-dim">
                            {formatBytes(p.bytesDone)} / {formatBytes(p.bytesTotal)}
                          </span>
                        </>
                      )}
                      {p.phase === "download" && !p.bytesTotal && <span className="amy-dim">{formatBytes(p.bytesDone)}</span>}
                    </div>
                  ) : (
                    app.lastResult && (
                      <div className="amy-lib-sub amy-dim">
                        {app.lastResult}
                        {app.lastChecked ? ` · ${formatWhen(new Date(app.lastChecked))}` : ""}
                      </div>
                    )
                  )}
                  {app.versions.length > 1 && (
                    <div className="amy-lib-sub amy-dim">Previous kept for rollback: v{app.versions[1].version} ({app.versions[1].build})</div>
                  )}
                </div>
                <div className="amy-lib-actions">
                  <button className="amy-primary-btn" onClick={() => onInstall(app)} disabled={busy || !current}>
                    Install
                  </button>
                  <button onClick={() => onCheck(app.bundleId)} disabled={checking || !app.source} title={app.source ? "Check now" : "Set an update source first"}>
                    Check
                  </button>
                  <button onClick={() => setEditing(editing === app.bundleId ? null : app.bundleId)}>Updates…</button>
                  <button className="amy-danger-btn" aria-label={`Remove ${app.name}`} onClick={() => remove(app)}>
                    ×
                  </button>
                </div>
                {editing === app.bundleId && (
                  <div className="amy-lib-edit-wrap">
                    <SourceEditor
                      app={app}
                      onCancel={() => setEditing(null)}
                      onSaved={() => {
                        setEditing(null);
                        onChanged();
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
