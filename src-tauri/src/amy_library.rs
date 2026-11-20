//! A.M.Y Loader: the app library.
//!
//! Every .ipa you give A.M.Y Loader is copied into
//! `%APPDATA%\uk.amy.loader\library\<bundle id>\`, so re-signing never breaks
//! because a file moved. Each app can have an update source; A.M.Y checks it,
//! downloads newer builds into the library and keeps the previous one for
//! rollback.
//!
//! Sources:
//!  - GitHub release   (`owner/repo`, newest release with an .ipa asset)
//!  - GitHub Actions   (`owner/repo` + workflow file; newest successful run's artifact)
//!  - AltStore/SideStore source (JSON feed URL)
//!  - Direct URL       (a link that always serves the newest .ipa)
//!
//! A GitHub token (needed for private repos and Actions artifacts) is kept in
//! Windows Credential Manager, never in a file.
//!
//! event `amy://library-progress` → { bundleId, phase, label, bytesDone, bytesTotal }

use std::{
    cmp::Ordering,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const LIBRARY_EVENT: &str = "amy://library-progress";
const KEEP_VERSIONS: usize = 2;
const KEYRING_SERVICE: &str = "uk.amy.loader";
const KEYRING_GITHUB: &str = "github-token";
const USER_AGENT: &str = "AMY-Loader";

// ── data ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryVersion {
    pub version: String,
    pub build: String,
    pub path: String,
    pub size: u64,
    pub added_at: String,
    /// imported | github | actions | altstore | url
    pub origin: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateSource {
    #[serde(rename_all = "camelCase")]
    Github { repo: String, asset: Option<String>, prerelease: bool },
    #[serde(rename_all = "camelCase")]
    Actions { repo: String, workflow: String, branch: String, artifact: Option<String> },
    #[serde(rename_all = "camelCase")]
    Altstore { url: String },
    #[serde(rename_all = "camelCase")]
    Url { url: String },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryApp {
    pub bundle_id: String,
    pub name: String,
    pub min_os: Option<String>,
    /// Newest first.
    pub versions: Vec<LibraryVersion>,
    pub source: Option<UpdateSource>,
    /// Install updates onto phones automatically once downloaded.
    pub auto_install: bool,
    pub last_checked: Option<String>,
    pub last_result: Option<String>,
    /// Identifies what the source last served (release id, artifact id, ETag),
    /// so the same build is never downloaded twice.
    pub remote_marker: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct LibraryFile {
    apps: Vec<LibraryApp>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpaInfo {
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    pub build: String,
    pub min_os: Option<String>,
    /// Size of the .ipa file in bytes.
    pub size: u64,
    /// The app has an Apple Health usage description, so A.M.Y Loader switches
    /// HealthKit on for its App ID before signing (see amy_capabilities.rs).
    pub wants_healthkit: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub bundle_id: String,
    pub name: String,
    /// updated | current | no_source | error
    pub status: String,
    pub message: String,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryProgress<'a> {
    bundle_id: &'a str,
    phase: &'a str,
    label: String,
    bytes_done: u64,
    bytes_total: u64,
}

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

// ── storage ──────────────────────────────────────────────────────────────────

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("No app data folder: {e}")))?
        .join("library");
    fs::create_dir_all(&dir).map_err(|e| err(format!("Can't create library folder: {e}")))?;
    Ok(dir)
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join("library.json"))
}

fn load(app: &AppHandle) -> Result<LibraryFile, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(LibraryFile::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| err(format!("Can't read library: {e}")))?;
    serde_json::from_str(&text).map_err(|e| err(format!("Library file is damaged: {e}")))
}

fn save(app: &AppHandle, lib: &LibraryFile) -> Result<(), String> {
    let path = index_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| err(format!("Can't save library: {e}")))?;
    fs::rename(&tmp, &path).map_err(|e| err(format!("Can't save library: {e}")))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// ── versions ─────────────────────────────────────────────────────────────────

fn numeric_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect()
}

fn cmp_dotted(a: &str, b: &str) -> Ordering {
    let (x, y) = (numeric_parts(a), numeric_parts(b));
    for i in 0..x.len().max(y.len()) {
        let o = x.get(i).unwrap_or(&0).cmp(y.get(i).unwrap_or(&0));
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

/// Compare (short version, build). "27.0.4" > "26.0.2"; equal versions fall back to the build number.
pub fn compare(a_ver: &str, a_build: &str, b_ver: &str, b_build: &str) -> Ordering {
    match cmp_dotted(a_ver, b_ver) {
        Ordering::Equal => cmp_dotted(a_build, b_build),
        o => o,
    }
}

// ── reading .ipa files ──────────────────────────────────────────────────────

fn is_app_info_plist(name: &str) -> bool {
    // Payload/<Name>.app/Info.plist (exactly that depth; ignore plug-ins/frameworks)
    let parts: Vec<&str> = name.split('/').collect();
    parts.len() == 3 && parts[0] == "Payload" && parts[1].ends_with(".app") && parts[2] == "Info.plist"
}

fn read_info_from_zip<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Result<Option<IpaInfo>, String> {
    let name = (0..archive.len())
        .filter_map(|i| archive.name_for_index(i).map(|s| s.to_string()))
        .find(|n| is_app_info_plist(n));
    let Some(name) = name else { return Ok(None) };
    let mut file = archive.by_name(&name).map_err(|e| err(format!("Can't read Info.plist: {e}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| err(format!("Can't read Info.plist: {e}")))?;
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|e| err(format!("Info.plist is invalid: {e}")))?;
    let dict = value.as_dictionary().ok_or_else(|| err("Info.plist is not a dictionary"))?;
    let get = |k: &str| dict.get(k).and_then(|v| v.as_string()).map(|s| s.to_string());
    let bundle_id = get("CFBundleIdentifier").ok_or_else(|| err("The app has no bundle identifier"))?;
    let app_folder = name.split('/').nth(1).unwrap_or("App.app").trim_end_matches(".app").to_string();
    Ok(Some(IpaInfo {
        name: get("CFBundleDisplayName").or_else(|| get("CFBundleName")).unwrap_or(app_folder),
        version: get("CFBundleShortVersionString").unwrap_or_else(|| "0".into()),
        build: get("CFBundleVersion").unwrap_or_else(|| "0".into()),
        min_os: get("MinimumOSVersion"),
        size: 0,
        wants_healthkit: crate::amy_capabilities::HEALTH_USAGE_KEYS.iter().any(|k| dict.contains_key(k)),
        bundle_id,
    }))
}

/// Read name, bundle id and version from an .ipa.
pub fn ipa_info(path: &Path) -> Result<IpaInfo, String> {
    let file = fs::File::open(path).map_err(|e| err(format!("Can't open {}: {e}", path.display())))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut archive = zip::ZipArchive::new(file).map_err(|_| err("That file isn't a valid .ipa (not a zip archive)."))?;
    let mut info = read_info_from_zip(&mut archive)?.ok_or_else(|| err("No app found inside (missing Payload/<App>.app/Info.plist)."))?;
    info.size = size;
    Ok(info)
}

/// Turn whatever the user gave us (an .ipa, or a .zip such as a GitHub
/// artifact with an .ipa inside) into a path to a real .ipa. Extracted files
/// go to `scratch`.
fn resolve_ipa(input: &Path, scratch: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(input).map_err(|e| err(format!("Can't open {}: {e}", input.display())))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| err("That file isn't an .ipa or a .zip."))?;
    if read_info_from_zip(&mut archive)?.is_some() {
        return Ok(input.to_path_buf());
    }
    // Look for the largest .ipa inside (e.g. "Amy-ipa.zip" → "Amy.ipa").
    let mut best: Option<(usize, u64, String)> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.to_lowercase().ends_with(".ipa") && !entry.is_dir() && best.as_ref().is_none_or(|b| entry.size() > b.1) {
            best = Some((i, entry.size(), name));
        }
    }
    let Some((index, _, name)) = best else {
        return Err(err("No .ipa found inside that zip."));
    };
    fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let file_name = Path::new(&name).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or("app.ipa".into());
    let out_path = scratch.join(safe_name(&file_name));
    let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
    let mut out = fs::File::create(&out_path).map_err(|e| err(format!("Can't extract the .ipa: {e}")))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| err(format!("Can't extract the .ipa: {e}")))?;
    out.flush().ok();
    Ok(out_path)
}

/// Copy a resolved .ipa into the library and record it. Returns the app and
/// the stored version.
fn store_ipa(app: &AppHandle, ipa: &Path, origin: &str, marker: Option<String>) -> Result<(LibraryApp, LibraryVersion, bool), String> {
    let info = ipa_info(ipa)?;
    let dir = root(app)?.join(safe_name(&info.bundle_id));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_name = safe_name(&format!("{}_{}_{}.ipa", info.name, info.version, info.build));
    let dest = dir.join(&file_name);
    if ipa != dest {
        fs::copy(ipa, &dest).map_err(|e| err(format!("Can't copy into the library: {e}")))?;
    }
    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let version = LibraryVersion {
        version: info.version.clone(),
        build: info.build.clone(),
        path: dest.to_string_lossy().to_string(),
        size,
        added_at: now(),
        origin: origin.to_string(),
    };

    let mut lib = load(app)?;
    let entry = match lib.apps.iter_mut().position(|a| a.bundle_id == info.bundle_id) {
        Some(i) => &mut lib.apps[i],
        None => {
            lib.apps.push(LibraryApp {
                bundle_id: info.bundle_id.clone(),
                name: info.name.clone(),
                min_os: info.min_os.clone(),
                versions: vec![],
                source: None,
                auto_install: false,
                last_checked: None,
                last_result: None,
                remote_marker: None,
            });
            lib.apps.last_mut().unwrap()
        }
    };
    let was_newest = entry
        .versions
        .first()
        .map(|v| compare(&info.version, &info.build, &v.version, &v.build) == Ordering::Greater)
        .unwrap_or(true);
    entry.name = info.name.clone();
    entry.min_os = info.min_os.clone();
    entry.versions.retain(|v| !(v.version == info.version && v.build == info.build));
    entry.versions.push(version.clone());
    entry.versions.sort_by(|a, b| compare(&b.version, &b.build, &a.version, &a.build));
    // Keep the newest few, plus the one just added even if it's older
    // (a deliberate downgrade); delete the rest from disk.
    let mut kept = Vec::new();
    for (i, v) in std::mem::take(&mut entry.versions).into_iter().enumerate() {
        if i < KEEP_VERSIONS || v.path == version.path {
            kept.push(v);
        } else {
            let _ = fs::remove_file(&v.path);
        }
    }
    entry.versions = kept;
    if marker.is_some() {
        entry.remote_marker = marker;
    }
    let snapshot = entry.clone();
    save(app, &lib)?;
    Ok((snapshot, version, was_newest))
}

// ── downloads ────────────────────────────────────────────────────────────────

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn github_token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_GITHUB)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|t| !t.trim().is_empty())
}

fn github_get(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let mut req = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = github_token() {
        req = req.bearer_auth(token);
    }
    req
}

async fn json(req: reqwest::RequestBuilder, what: &str) -> Result<serde_json::Value, String> {
    let res = req.send().await.map_err(|e| err(format!("{what}: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            401 => " — the GitHub token is wrong or expired",
            403 => " — rate-limited or the token lacks access",
            404 => " — not found (private repos need a GitHub token)",
            _ => "",
        };
        return Err(err(format!("{what}: HTTP {status}{hint}")));
    }
    res.json().await.map_err(|e| err(format!("{what}: bad JSON ({e})")))
}

/// Stream a download to `dest`, reporting progress.
async fn download(app: &AppHandle, bundle_id: &str, req: reqwest::RequestBuilder, dest: &Path) -> Result<(), String> {
    let mut res = req.send().await.map_err(|e| err(format!("Download failed: {e}")))?;
    if !res.status().is_success() {
        return Err(err(format!("Download failed: HTTP {}", res.status())));
    }
    let total = res.content_length().unwrap_or(0);
    let mut out = fs::File::create(dest).map_err(|e| err(format!("Can't write download: {e}")))?;
    let mut done: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let emit = |done: u64| {
        let _ = app.emit(
            LIBRARY_EVENT,
            LibraryProgress { bundle_id, phase: "download", label: "Downloading the new version".into(), bytes_done: done, bytes_total: total },
        );
    };
    emit(0);
    while let Some(chunk) = res.chunk().await.map_err(|e| err(format!("Download interrupted: {e}")))? {
        out.write_all(&chunk).map_err(|e| err(format!("Can't write download: {e}")))?;
        done += chunk.len() as u64;
        if last_emit.elapsed().as_millis() > 150 {
            emit(done);
            last_emit = std::time::Instant::now();
        }
    }
    out.flush().ok();
    emit(done);
    Ok(())
}

fn phase(app: &AppHandle, bundle_id: &str, phase: &str, label: impl Into<String>) {
    let _ = app.emit(
        LIBRARY_EVENT,
        LibraryProgress { bundle_id, phase, label: label.into(), bytes_done: 0, bytes_total: 0 },
    );
}

/// What a source currently offers.
struct Remote {
    marker: String,
    /// Version the source claims, if it says (checked again after download).
    version: Option<String>,
    request: reqwest::RequestBuilder,
    origin: &'static str,
}

async fn resolve_remote(client: &reqwest::Client, app: &LibraryApp) -> Result<Option<Remote>, String> {
    match app.source.as_ref() {
        None => Ok(None),
        Some(UpdateSource::Github { repo, asset, prerelease }) => {
            let release = if *prerelease {
                let list = json(github_get(client, &format!("https://api.github.com/repos/{repo}/releases?per_page=10")), "GitHub releases").await?;
                list.as_array()
                    .and_then(|a| a.iter().find(|r| !r["draft"].as_bool().unwrap_or(false)).cloned())
                    .ok_or_else(|| err("That repo has no releases"))?
            } else {
                json(github_get(client, &format!("https://api.github.com/repos/{repo}/releases/latest")), "GitHub latest release").await?
            };
            let pattern = asset.as_deref().map(|s| s.to_lowercase());
            let chosen = release["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| a["name"].as_str().map(|n| n.to_lowercase().ends_with(".ipa")).unwrap_or(false))
                .find(|a| pattern.as_ref().is_none_or(|p| a["name"].as_str().unwrap_or("").to_lowercase().contains(p)))
                .ok_or_else(|| err("The latest release has no matching .ipa file"))?;
            let url = chosen["url"].as_str().ok_or_else(|| err("Release asset has no URL"))?;
            let mut req = client.get(url).header("Accept", "application/octet-stream");
            if let Some(t) = github_token() {
                req = req.bearer_auth(t);
            }
            Ok(Some(Remote {
                marker: format!("gh-asset:{}:{}", chosen["id"], chosen["updated_at"].as_str().unwrap_or("")),
                version: release["tag_name"].as_str().map(|s| s.trim_start_matches(['v', 'V']).to_string()),
                request: req,
                origin: "github",
            }))
        }
        Some(UpdateSource::Actions { repo, workflow, branch, artifact }) => {
            if github_token().is_none() {
                return Err(err("GitHub Actions downloads need a GitHub token (Library → GitHub token)."));
            }
            let runs = json(
                github_get(
                    client,
                    &format!("https://api.github.com/repos/{repo}/actions/workflows/{workflow}/runs?branch={branch}&status=success&per_page=5"),
                ),
                "GitHub Actions runs",
            )
            .await?;
            let run = runs["workflow_runs"].as_array().and_then(|a| a.first()).ok_or_else(|| err("No successful builds yet"))?;
            let artifacts_url = run["artifacts_url"].as_str().ok_or_else(|| err("Build has no artifacts"))?;
            let list = json(github_get(client, artifacts_url), "Build artifacts").await?;
            let pattern = artifact.as_deref().map(|s| s.to_lowercase());
            let chosen = list["artifacts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| !a["expired"].as_bool().unwrap_or(false))
                .find(|a| pattern.as_ref().is_none_or(|p| a["name"].as_str().unwrap_or("").to_lowercase().contains(p)))
                .ok_or_else(|| err("The newest build has no (unexpired) artifact"))?;
            let url = chosen["archive_download_url"].as_str().ok_or_else(|| err("Artifact has no download URL"))?;
            Ok(Some(Remote {
                marker: format!("gh-artifact:{}", chosen["id"]),
                version: None,
                request: github_get(client, url),
                origin: "actions",
            }))
        }
        Some(UpdateSource::Altstore { url }) => {
            let feed = json(client.get(url), "AltStore source").await?;
            let entry = feed["apps"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|a| a["bundleIdentifier"].as_str() == Some(app.bundle_id.as_str()))
                .ok_or_else(|| err(format!("That source doesn't list {}", app.bundle_id)))?;
            // Newer feeds have versions[]; older ones put version/downloadURL on the app.
            let mut candidates: Vec<(String, String, String)> = entry["versions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    Some((
                        v["version"].as_str()?.to_string(),
                        v["buildVersion"].as_str().unwrap_or("").to_string(),
                        v["downloadURL"].as_str()?.to_string(),
                    ))
                })
                .collect();
            if let (Some(v), Some(u)) = (entry["version"].as_str(), entry["downloadURL"].as_str()) {
                candidates.push((v.to_string(), String::new(), u.to_string()));
            }
            candidates.sort_by(|a, b| compare(&b.0, &b.1, &a.0, &a.1));
            let (version, build, download) = candidates.into_iter().next().ok_or_else(|| err("That source has no downloadable version"))?;
            Ok(Some(Remote {
                marker: format!("altstore:{version}:{build}"),
                version: Some(version),
                request: client.get(download),
                origin: "altstore",
            }))
        }
        Some(UpdateSource::Url { url }) => {
            // Ask for headers only, so an unchanged file isn't downloaded again.
            let head = client.head(url).send().await.map_err(|e| err(format!("Update link: {e}")))?;
            let h = head.headers();
            let tag = h
                .get("etag")
                .or_else(|| h.get("last-modified"))
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("len:{}", head.content_length().unwrap_or(0)));
            Ok(Some(Remote { marker: format!("url:{tag}"), version: None, request: client.get(url), origin: "url" }))
        }
    }
}

async fn check_one(app: &AppHandle, entry: &LibraryApp) -> CheckResult {
    let base = |status: &str, message: String| CheckResult {
        bundle_id: entry.bundle_id.clone(),
        name: entry.name.clone(),
        status: status.into(),
        message,
        version: None,
        path: None,
    };
    if entry.source.is_none() {
        return base("no_source", "No update source set".into());
    }
    let current = entry.versions.first();
    phase(app, &entry.bundle_id, "check", format!("Checking {} for updates", entry.name));

    let outcome: Result<CheckResult, String> = async {
        let client = http()?;
        let Some(remote) = resolve_remote(&client, entry).await? else {
            return Ok(base("no_source", "No update source set".into()));
        };
        if entry.remote_marker.as_deref() == Some(remote.marker.as_str()) {
            return Ok(base("current", format!("Up to date ({})", current.map(|c| c.version.as_str()).unwrap_or("?"))));
        }
        // If the source says its version, skip the download when it isn't newer.
        if let (Some(v), Some(c)) = (remote.version.as_deref(), current) {
            if cmp_dotted(v, &c.version) == Ordering::Less {
                return Ok(base("current", format!("Up to date ({}; source offers {v})", c.version)));
            }
        }
        let scratch = std::env::temp_dir().join(format!("amy-loader-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
        let downloaded = scratch.join("download.bin");
        let result = async {
            download(app, &entry.bundle_id, remote.request, &downloaded).await?;
            phase(app, &entry.bundle_id, "verify", "Checking the download");
            let ipa = resolve_ipa(&downloaded, &scratch.join("x"))?;
            let info = ipa_info(&ipa)?;
            if info.bundle_id != entry.bundle_id {
                return Err(err(format!("The download is a different app ({}), not {}", info.bundle_id, entry.bundle_id)));
            }
            let newer = current
                .map(|c| compare(&info.version, &info.build, &c.version, &c.build) == Ordering::Greater)
                .unwrap_or(true);
            if !newer {
                // remember this build so it isn't fetched again
                let mut lib = load(app)?;
                if let Some(a) = lib.apps.iter_mut().find(|a| a.bundle_id == entry.bundle_id) {
                    a.remote_marker = Some(remote.marker.clone());
                }
                save(app, &lib)?;
                return Ok(base("current", format!("Up to date ({} build {})", info.version, info.build)));
            }
            let (_, stored, _) = store_ipa(app, &ipa, remote.origin, Some(remote.marker.clone()))?;
            Ok(CheckResult {
                bundle_id: entry.bundle_id.clone(),
                name: entry.name.clone(),
                status: "updated".into(),
                message: format!(
                    "Downloaded {} {}{}",
                    entry.name,
                    stored.version,
                    current.map(|c| format!(" (was {})", c.version)).unwrap_or_default()
                ),
                version: Some(stored.version.clone()),
                path: Some(stored.path.clone()),
            })
        }
        .await;
        let _ = fs::remove_dir_all(&scratch);
        result
    }
    .await;

    let result = outcome.unwrap_or_else(|e| base("error", e));
    // record when/what for the UI
    if let Ok(mut lib) = load(app) {
        if let Some(a) = lib.apps.iter_mut().find(|a| a.bundle_id == entry.bundle_id) {
            a.last_checked = Some(now());
            a.last_result = Some(result.message.clone());
        }
        let _ = save(app, &lib);
    }
    phase(app, &entry.bundle_id, "idle", result.message.clone());
    result
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn amy_library_list(app: AppHandle) -> Result<Vec<LibraryApp>, String> {
    Ok(load(&app)?.apps)
}

#[tauri::command]
pub fn amy_ipa_info(path: String) -> Result<IpaInfo, String> {
    ipa_info(Path::new(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub app: LibraryApp,
    pub version: LibraryVersion,
    /// True when this is now the newest version of the app in the library.
    pub newest: bool,
}

/// Save an .ipa (or a .zip containing one) into the library.
#[tauri::command]
pub async fn amy_library_import(app: AppHandle, path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scratch = std::env::temp_dir().join(format!("amy-loader-{}", uuid::Uuid::new_v4()));
        let result = resolve_ipa(Path::new(&path), &scratch).and_then(|ipa| store_ipa(&app, &ipa, "imported", None));
        let _ = fs::remove_dir_all(&scratch);
        result.map(|(app, version, newest)| ImportResult { app, version, newest })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn amy_library_remove(app: AppHandle, bundle_id: String) -> Result<(), String> {
    let mut lib = load(&app)?;
    if let Some(i) = lib.apps.iter().position(|a| a.bundle_id == bundle_id) {
        let removed = lib.apps.remove(i);
        for v in removed.versions {
            let _ = fs::remove_file(v.path);
        }
        let _ = fs::remove_dir(root(&app)?.join(safe_name(&bundle_id)));
    }
    save(&app, &lib)
}

#[tauri::command]
pub fn amy_library_set_source(
    app: AppHandle,
    bundle_id: String,
    source: Option<UpdateSource>,
    auto_install: bool,
) -> Result<LibraryApp, String> {
    let mut lib = load(&app)?;
    let entry = lib
        .apps
        .iter_mut()
        .find(|a| a.bundle_id == bundle_id)
        .ok_or_else(|| err("That app isn't in the library"))?;
    if entry.source != source {
        entry.remote_marker = None; // new source: check from scratch
        entry.last_result = None;
    }
    entry.source = source;
    entry.auto_install = auto_install;
    let snapshot = entry.clone();
    save(&app, &lib)?;
    Ok(snapshot)
}

/// Check one app (or all apps with a source) for a newer version.
#[tauri::command]
pub async fn amy_library_check(app: AppHandle, bundle_id: Option<String>) -> Result<Vec<CheckResult>, String> {
    let apps: Vec<LibraryApp> = load(&app)?
        .apps
        .into_iter()
        .filter(|a| bundle_id.as_ref().is_none_or(|b| &a.bundle_id == b))
        .filter(|a| a.source.is_some() || bundle_id.is_some())
        .collect();
    let mut results = Vec::new();
    for entry in &apps {
        results.push(check_one(&app, entry).await);
    }
    Ok(results)
}

#[tauri::command]
pub fn amy_library_folder(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn amy_github_token_set(token: Option<String>) -> Result<bool, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_GITHUB).map_err(|e| e.to_string())?;
    match token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(t) => entry.set_password(&t).map_err(|e| err(format!("Couldn't save the token: {e}")))?,
        None => {
            let _ = entry.delete_credential();
        }
    }
    Ok(github_token().is_some())
}

#[tauri::command]
pub fn amy_github_token_present() -> bool {
    github_token().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_ordering() {
        assert_eq!(compare("27.0.4", "1", "26.0.2", "9"), Ordering::Greater);
        assert_eq!(compare("v1.2", "", "1.2.0", ""), Ordering::Equal);
        assert_eq!(compare("1.2", "10", "1.2", "9"), Ordering::Greater);
        assert_eq!(compare("1.10", "", "1.9", ""), Ordering::Greater);
        assert_eq!(compare("0.0.1", "3", "0.0.1", "12"), Ordering::Less);
    }

    /// Real-file check: AMY_TEST_IPA=<path to .ipa or .zip> cargo test -- --ignored
    #[test]
    #[ignore]
    fn resolves_real_file() {
        let Ok(input) = std::env::var("AMY_TEST_IPA") else { return };
        let scratch = std::env::temp_dir().join("amy-loader-test");
        let ipa = resolve_ipa(Path::new(&input), &scratch).expect("resolve");
        let info = ipa_info(&ipa).expect("info");
        println!("{} {} ({}) {} bytes min iOS {:?}", info.bundle_id, info.version, info.build, info.size, info.min_os);
        assert!(!info.bundle_id.is_empty());
        let _ = fs::remove_dir_all(scratch);
    }

    #[test]
    fn info_plist_depth() {
        assert!(is_app_info_plist("Payload/Amy.app/Info.plist"));
        assert!(!is_app_info_plist("Payload/Amy.app/PlugIns/X.appex/Info.plist"));
        assert!(!is_app_info_plist("Amy.app/Info.plist"));
    }
}
