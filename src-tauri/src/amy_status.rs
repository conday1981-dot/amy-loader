//! A.M.Y Loader: sign-in identity failover + live service status.
//!
//! ## Why the failover exists
//! At sign-in, iloader tells Apple's GrandSlam server (gsa.apple.com) which
//! Mac it is pretending to be (the "client info"). Apple periodically starts
//! refusing one of those identities with HTTP 503 Service Temporarily
//! Unavailable — Aug 2026, Oct 2026 and again on 19 Nov 2026 (iloader 2.4.1's
//! "Mac15,7 / macOS 27" identity). Each time, sideloading stops until a new
//! iloader engine ships.
//!
//! So A.M.Y keeps a short list of known identities and, when GrandSlam answers
//! 502/503/504, signs in again with the next one. The identity that worked is
//! remembered (data.json → `amyClientProfile`) and tried first next time.
//! Only server-unavailable answers trigger a retry: a wrong password, a locked
//! account or a rate limit (429) fails straight away, so the failover can
//! never hammer Apple or lock an account.
//!
//! When an engine sync changes the identity in iloader's `account.rs`, the
//! merge will conflict there on purpose: add the new identity to `PROFILES`
//! (first, if it is upstream's new default) and keep the call into this file.
//!
//! ## Status
//! `amy_status_check` probes the services sideloading depends on and combines
//! that with what actually happened in the last sign-in and install, so the
//! header can say what is working, down or blocked — and what to do about it.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use isideload::{
    anisette::{AnisetteClientInfo, remote_v3::RemoteV3AnisetteProvider},
    auth::apple_account::AppleAccount,
    util::callbacks::TwoFactorCallback,
};
use rootcause::Report;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
use tracing::{info, warn};

use crate::{error::AppError, secure_storage::create_sideloading_storage};

/// Front-end event: something the status panel shows has changed.
pub const STATUS_EVENT: &str = "amy://status-changed";
const STORE_FILE: &str = "data.json";
const STORE_PROFILE_KEY: &str = "amyClientProfile";
/// Pause before signing in again with the next identity.
const FAILOVER_PAUSE: Duration = Duration::from_secs(3);
/// Each status probe gives up after this long.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// A sign-in or install older than this no longer colours the status.
const OUTCOME_FRESH_MS: i64 = 12 * 60 * 60 * 1000;
/// How long a GitHub engine-version answer is reused.
const ENGINE_CACHE_MS: i64 = 60 * 60 * 1000;

// ── sign-in identities ───────────────────────────────────────────────────────

pub struct ClientProfile {
    pub id: &'static str,
    pub label: &'static str,
    /// `None` = use whatever the anisette server reports.
    client_info: Option<(&'static str, &'static str)>,
}

impl ClientProfile {
    fn client_info(&self) -> Option<AnisetteClientInfo> {
        self.client_info.map(|(client_info, user_agent)| AnisetteClientInfo {
            client_info: client_info.to_string(),
            user_agent: user_agent.to_string(),
        })
    }
}

/// Default order. The first entry is the identity the current iloader engine
/// (2.4.2) uses.
pub const PROFILES: &[ClientProfile] = &[
    ClientProfile {
        id: "mac-10.12",
        label: "Older Mac (macOS 10.12)",
        client_info: Some((
            "<MacBookPro13,3> <Mac OS X;10.12.6;16G29> <com.apple.AuthKit/1 (com.apple.akd/1.0)>",
            "akd/1.0 CFNetwork/811.5.4 Darwin/16.7.0",
        )),
    },
    ClientProfile {
        id: "mac-27",
        label: "Newer Mac (macOS 27)",
        client_info: Some((
            "<Mac15,7> <macOS;27.0;26A5378j> <com.apple.AuthKit/1 (com.apple.akd/1.0)>",
            "akd/1.0 CFNetwork/811.5.4",
        )),
    },
    ClientProfile {
        id: "anisette",
        label: "Anisette server's own",
        client_info: None,
    },
];

fn profile_by_id(id: &str) -> Option<&'static ClientProfile> {
    PROFILES.iter().find(|p| p.id == id)
}

fn remembered_profile(app: &AppHandle) -> Option<&'static ClientProfile> {
    let store = app.store(STORE_FILE).ok()?;
    let id = store.get(STORE_PROFILE_KEY)?;
    profile_by_id(id.as_str()?)
}

fn remember_profile(app: &AppHandle, profile: &ClientProfile) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(STORE_PROFILE_KEY, Value::String(profile.id.to_string()));
    }
}

/// Remembered identity first, then the rest in default order.
fn profile_order(app: &AppHandle) -> Vec<&'static ClientProfile> {
    let first = remembered_profile(app);
    first
        .into_iter()
        .chain(PROFILES.iter().filter(|p| Some(p.id) != first.map(|f| f.id)))
        .collect()
}

/// True when Apple's sign-in server answered 502/503/504 — i.e. it refused
/// the request without judging the credentials.
fn grandslam_unavailable(report: &Report) -> bool {
    for cause in report.iter_reports() {
        if let Some(err) = cause.downcast_current_context::<reqwest::Error>() {
            let from_gsa = err
                .url()
                .and_then(|u| u.host_str())
                .is_some_and(|h| h.ends_with("gsa.apple.com"));
            let unavailable = err.status().is_some_and(|s| matches!(s.as_u16(), 502..=504));
            if from_gsa && unavailable {
                return true;
            }
        }
    }
    // Fallback in case the error is ever wrapped in a different type.
    let text = report.to_string();
    text.contains("gsa.apple.com")
        && ["502 ", "503 ", "504 "].iter().any(|code| text.contains(code))
}

/// Sign in, moving to the next identity whenever GrandSlam answers 502/503/504.
pub async fn login_with_failover<C>(
    app: &AppHandle,
    email: &str,
    password: &str,
    anisette_url: &str,
    two_factor: C,
) -> Result<AppleAccount, AppError>
where
    C: TwoFactorCallback + Clone,
{
    let order = profile_order(app);
    let mut refused: Vec<&'static str> = Vec::new();

    for (i, profile) in order.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(FAILOVER_PAUSE).await;
        }
        info!("Signing in to Apple as '{}'", profile.label);
        let provider = RemoteV3AnisetteProvider::default()?
            .set_serial_number("0".to_string())
            .set_storage(create_sideloading_storage(app)?)
            .set_client_info_override(profile.client_info())
            .set_url(anisette_url);

        let attempt = AppleAccount::builder(email)
            .anisette_provider(provider)
            .login(password, two_factor.clone())
            .await;

        match attempt {
            Ok(account) => {
                remember_profile(app, profile);
                record_login(app, LoginOutcome::SignedIn {
                    profile: profile.label,
                    refused: refused.clone(),
                });
                return Ok(account);
            }
            Err(report) if grandslam_unavailable(&report) => {
                warn!(
                    "Apple's sign-in server refused identity '{}' (HTTP 5xx){}",
                    profile.label,
                    if i + 1 < order.len() { "; trying the next one" } else { "" }
                );
                refused.push(profile.label);
                if i + 1 == order.len() {
                    let err = AppError::from(report);
                    record_login(app, LoginOutcome::AllRefused);
                    return Err(err);
                }
            }
            Err(report) => {
                let err = AppError::from(report);
                record_login(app, LoginOutcome::Failed {
                    kind: err.as_ref().to_string(),
                    message: err.to_string(),
                });
                return Err(err);
            }
        }
    }
    // PROFILES is never empty, so the loop always returns.
    Err(AppError::Misc("No sign-in identities configured".into()))
}

// ── what actually happened (feeds the status panel) ──────────────────────────

#[derive(Clone)]
enum LoginOutcome {
    SignedIn { profile: &'static str, refused: Vec<&'static str> },
    AllRefused,
    Failed { kind: String, message: String },
}

#[derive(Clone)]
struct Stamped<T> {
    at_ms: i64,
    value: T,
}

#[derive(Clone)]
enum InstallOutcome {
    Ok,
    Failed { kind: String, message: String },
}

#[derive(Default)]
struct Memory {
    login: Option<Stamped<LoginOutcome>>,
    install: Option<Stamped<InstallOutcome>>,
    /// (checked at, latest iloader tag or error)
    engine: Option<(i64, Result<String, String>)>,
}

static MEMORY: LazyLock<Mutex<Memory>> = LazyLock::new(|| Mutex::new(Memory::default()));

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn record_login(app: &AppHandle, outcome: LoginOutcome) {
    MEMORY.lock().unwrap().login = Some(Stamped { at_ms: now_ms(), value: outcome });
    let _ = app.emit(STATUS_EVENT, ());
}

/// Called with every install result (manual, library and auto-refresh).
pub fn note_install_result(app: &AppHandle, result: &Result<(), AppError>) {
    let outcome = match result {
        Ok(()) => InstallOutcome::Ok,
        Err(e) => InstallOutcome::Failed { kind: e.as_ref().to_string(), message: e.to_string() },
    };
    MEMORY.lock().unwrap().install = Some(Stamped { at_ms: now_ms(), value: outcome });
    let _ = app.emit(STATUS_EVENT, ());
}

// ── status report ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ok,
    Unknown,
    Warn,
    Down,
    Blocked,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusItem {
    id: &'static str,
    label: &'static str,
    state: Health,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fix: Option<String>,
    /// When the event this row is based on happened (ms), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    at_ms: Option<i64>,
}

impl StatusItem {
    fn new(id: &'static str, label: &'static str, state: Health, summary: impl Into<String>) -> Self {
        Self { id, label, state, summary: summary.into(), fix: None, at_ms: None }
    }
    fn fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
    fn at(mut self, at_ms: i64) -> Self {
        self.at_ms = Some(at_ms);
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    items: Vec<StatusItem>,
    checked_at_ms: i64,
    /// Identity the next sign-in will try first.
    identity: &'static str,
    engine_version: &'static str,
}

enum Probe {
    Http(u16, String),
    Failed(String),
}

async fn probe(client: &reqwest::Client, url: &str) -> Probe {
    match client.get(url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            Probe::Http(status, body)
        }
        Err(e) if e.is_timeout() => Probe::Failed("timed out".into()),
        Err(e) if e.is_connect() => Probe::Failed("couldn't connect".into()),
        Err(e) => Probe::Failed(e.to_string()),
    }
}

/// Fetch GrandSlam's URL bag the way isideload does at the start of every
/// sign-in (same headers, same identity), so this reflects what a real sign-in
/// would get rather than a bare ping.
async fn gsa_probe(client: &reqwest::Client, profile: &ClientProfile) -> Probe {
    let (client_info, user_agent) = profile.client_info.unwrap_or(
        PROFILES[0].client_info.expect("first profile has a client identity"),
    );
    let req = client
        .get("https://gsa.apple.com/grandslam/GsService2/lookup")
        .header("Content-Type", "text/x-xml-plist")
        .header("Accept", "text/x-xml-plist")
        .header("X-Mme-Client-Info", client_info)
        .header("User-Agent", user_agent)
        .header("X-Xcode-Version", "27.0 (27A5218g)")
        .header("X-Apple-App-Info", "com.apple.gs.xcode.auth");
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            Probe::Http(status, body)
        }
        Err(e) if e.is_timeout() => Probe::Failed("timed out".into()),
        Err(e) if e.is_connect() => Probe::Failed("couldn't connect".into()),
        Err(e) => Probe::Failed(e.to_string()),
    }
}

fn status_text(code: u16) -> String {
    match code {
        429 => "HTTP 429 Too Many Requests".into(),
        502 => "HTTP 502 Bad Gateway".into(),
        503 => "HTTP 503 Service Unavailable".into(),
        504 => "HTTP 504 Gateway Timeout".into(),
        c => format!("HTTP {c}"),
    }
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().trim_start_matches('v').split(['.', '-', '+']);
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn fresh(at_ms: i64) -> bool {
    now_ms() - at_ms < OUTCOME_FRESH_MS
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    let h = haystack.to_lowercase();
    needles.iter().any(|n| h.contains(&n.to_lowercase()))
}

fn internet_item(p: &Probe) -> StatusItem {
    const L: &str = "Internet";
    match p {
        Probe::Http(200, body) if body.contains("Success") => {
            StatusItem::new("internet", L, Health::Ok, "Online")
        }
        Probe::Http(code, _) => StatusItem::new("internet", L, Health::Warn, format!("Something on this network is intercepting traffic ({})", status_text(*code)))
            .fix("A hotel/work Wi-Fi login page or a filter can do this — sign in to the network or switch to another one."),
        Probe::Failed(why) => StatusItem::new("internet", L, Health::Down, format!("No internet ({why})"))
            .fix("Check the laptop's Wi-Fi or cable."),
    }
}

fn signin_item(p: &Probe, login: Option<Stamped<LoginOutcome>>) -> StatusItem {
    const L: &str = "Apple sign-in";
    let mut item = match p {
        Probe::Http(code, _) if *code >= 500 => StatusItem::new("signin", L, Health::Down, format!("Apple's sign-in server is erroring ({})", status_text(*code)))
            .fix("This is on Apple's side. Wait and try again later."),
        Probe::Http(200, body) if body.contains("urls") => {
            StatusItem::new("signin", L, Health::Ok, "Apple's sign-in server is answering")
        }
        Probe::Http(code, _) => StatusItem::new("signin", L, Health::Warn, format!("Apple's sign-in server gave an unexpected answer ({})", status_text(*code)))
            .fix("Try signing in; if it fails, the row will show what Apple said."),
        Probe::Failed(why) => StatusItem::new("signin", L, Health::Down, format!("Can't reach gsa.apple.com ({why})"))
            .fix("If the internet is fine, a firewall, VPN or DNS filter may be blocking Apple."),
    };

    // What actually happened at the last sign-in matters more than a ping.
    if let Some(Stamped { at_ms, value }) = login.filter(|s| fresh(s.at_ms)) {
        item = match value {
            LoginOutcome::SignedIn { profile, refused } if refused.is_empty() => {
                StatusItem::new("signin", L, Health::Ok.max(item.state), format!("Signed in fine as \"{profile}\""))
            }
            LoginOutcome::SignedIn { profile, refused } => StatusItem::new(
                "signin",
                L,
                Health::Warn.max(item.state),
                format!("Working, but Apple refused \"{}\", so A.M.Y switched to \"{profile}\" automatically", refused.join("\", \"")),
            )
            .fix("Nothing to do now. A newer iloader engine usually follows within a day or two."),
            LoginOutcome::AllRefused => StatusItem::new(
                "signin",
                L,
                Health::Down,
                "Apple turned away sign-in from every identity A.M.Y knows (HTTP 503)",
            )
            .fix("Usually fixed by a newer iloader engine (see the engine row), or Apple recovers on its own within hours."),
            LoginOutcome::Failed { kind, message } => classify_login_failure(&kind, &message),
        }
        .at(at_ms);
    }
    item
}

fn classify_login_failure(kind: &str, message: &str) -> StatusItem {
    const L: &str = "Apple sign-in";
    if kind == "account_locked" {
        return StatusItem::new("signin", L, Health::Blocked, "Apple has locked this Apple ID")
            .fix("Unlock it at iforgot.apple.com, then sign in again.");
    }
    if contains_any(message, &["429", "too many requests"]) {
        return StatusItem::new("signin", L, Health::Warn, "Apple is rate-limiting sign-ins (HTTP 429)")
            .fix("Wait 15–30 minutes before trying again. Repeated attempts extend the wait.");
    }
    if kind == "anisette" {
        return StatusItem::new("signin", L, Health::Down, "Sign-in failed because the anisette server didn't respond properly")
            .fix("Pick a different anisette server in Settings, or use Settings → Reset anisette state.");
    }
    if contains_any(message, &["-22406", "incorrect", "password"]) {
        return StatusItem::new("signin", L, Health::Warn, "Apple rejected the Apple ID or password")
            .fix("Check the password for the signing Apple ID.");
    }
    StatusItem::new("signin", L, Health::Warn, "The last sign-in failed")
        .fix("Open the error details from the sign-in screen for the full message.")
}

fn anisette_item(server: &str, p: &Probe, login: &Option<Stamped<LoginOutcome>>) -> StatusItem {
    const L: &str = "Anisette server";
    let base = match p {
        Probe::Http(200, body) if body.contains("client_info") => {
            StatusItem::new("anisette", L, Health::Ok, format!("{server} is answering"))
        }
        Probe::Http(code, _) => StatusItem::new("anisette", L, Health::Down, format!("{server} answered {}", status_text(*code)))
            .fix("Settings → Anisette server → choose another server."),
        Probe::Failed(why) => StatusItem::new("anisette", L, Health::Down, format!("Can't reach {server} ({why})"))
            .fix("Settings → Anisette server → choose another server."),
    };
    let anisette_failed = matches!(
        login,
        Some(Stamped { at_ms, value: LoginOutcome::Failed { kind, .. } }) if kind == "anisette" && fresh(*at_ms)
    );
    if anisette_failed && base.state == Health::Ok {
        return StatusItem::new("anisette", L, Health::Warn, format!("{server} is up, but the last sign-in couldn't use its data"))
            .fix("Settings → Reset anisette state, or choose another server.");
    }
    base
}

fn developer_item(p: &Probe) -> StatusItem {
    const L: &str = "Apple developer services";
    match p {
        Probe::Http(code, _) if *code >= 500 => StatusItem::new("developer", L, Health::Down, format!("Apple's developer services are erroring ({})", status_text(*code)))
            .fix("Certificates and app IDs can't be created until Apple recovers. Try again later."),
        Probe::Http(_, _) => StatusItem::new("developer", L, Health::Ok, "Reachable"),
        Probe::Failed(why) => StatusItem::new("developer", L, Health::Down, format!("Can't reach developerservices2.apple.com ({why})"))
            .fix("If the internet is fine, a firewall, VPN or DNS filter may be blocking Apple."),
    }
}

fn install_item(install: Option<Stamped<InstallOutcome>>) -> StatusItem {
    const L: &str = "Signing & install";
    let Some(Stamped { at_ms, value }) = install.filter(|s| fresh(s.at_ms)) else {
        return StatusItem::new("install", L, Health::Unknown, "No installs in the last 12 hours");
    };
    let item = match value {
        InstallOutcome::Ok => StatusItem::new("install", L, Health::Ok, "Last install worked"),
        InstallOutcome::Failed { kind, message } => {
            if contains_any(&message, &["0xe8008024", "banned"]) {
                StatusItem::new("install", L, Health::Blocked, "Apple has banned the provisioning profile for this Apple ID")
                    .fix("Sign in with a different signing-only Apple ID (Apple IDs → add).")
            } else if kind == "not_enough_app_ids" {
                StatusItem::new("install", L, Health::Warn, "Out of app IDs (free accounts get 10 per 7 days)")
                    .fix("Wait for older app IDs to expire, or remove unused ones under Advanced → App IDs.")
            } else if kind == "max_apps" {
                StatusItem::new("install", L, Health::Warn, "This phone already has the 3 sideloaded apps a free account allows")
                    .fix("Delete one sideloaded app from the phone, then try again.")
            } else if kind == "not_logged_in" {
                StatusItem::new("install", L, Health::Warn, "Install skipped: not signed in")
                    .fix("Sign in with the signing Apple ID.")
            } else if matches!(kind.as_str(), "device_coms" | "device_coms_with_message" | "usbmuxd" | "no_device_selected") {
                StatusItem::new("install", L, Health::Warn, "Couldn't talk to the phone during the install")
                    .fix("Unlock the phone, keep it on the same Wi-Fi (or plug it in), and try again.")
            } else if contains_any(&message, &["429", "too many requests"]) {
                StatusItem::new("install", L, Health::Warn, "Apple is rate-limiting requests (HTTP 429)")
                    .fix("Wait 15–30 minutes before trying again.")
            } else {
                StatusItem::new("install", L, Health::Warn, "The last install failed")
                    .fix("The error screen has the full message and iloader's suggestions.")
            }
        }
    };
    item.at(at_ms)
}

async fn engine_item(client: &reqwest::Client, force: bool) -> StatusItem {
    const L: &str = "iloader engine";
    let current = env!("CARGO_PKG_VERSION");
    let cached = MEMORY.lock().unwrap().engine.clone();
    let max_age = if force { 5 * 60 * 1000 } else { ENGINE_CACHE_MS };
    let latest = match cached.filter(|(at, _)| now_ms() - at < max_age) {
        Some((_, latest)) => latest,
        None => {
            let latest = match client
                .get("https://api.github.com/repos/nab138/iloader/releases/latest")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => resp
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("tag_name")?.as_str().map(str::to_string))
                    .ok_or_else(|| "unexpected answer from GitHub".to_string()),
                Ok(resp) => Err(status_text(resp.status().as_u16())),
                Err(e) => Err(if e.is_timeout() { "timed out".into() } else { "couldn't connect".into() }),
            };
            MEMORY.lock().unwrap().engine = Some((now_ms(), latest.clone()));
            latest
        }
    };
    match latest {
        Ok(tag) => match (parse_version(&tag), parse_version(current)) {
            (Some(new), Some(cur)) if new > cur => StatusItem::new(
                "engine",
                L,
                Health::Warn,
                format!("iloader {tag} is out; A.M.Y is on {current}"),
            )
            .fix("Fixes for Apple sign-in changes usually land here first. Run the \"Check for iloader engine updates\" action on GitHub to merge it in."),
            _ => StatusItem::new("engine", L, Health::Ok, format!("Up to date ({current})")),
        },
        Err(why) => StatusItem::new("engine", L, Health::Unknown, format!("Couldn't check GitHub ({why}); running {current}")),
    }
}

/// Probe the services sideloading depends on. `force` = the user pressed
/// "Check now" (refreshes the GitHub engine check if it's over 5 minutes old).
#[tauri::command]
pub async fn amy_status_check(
    app: AppHandle,
    anisette_server: String,
    force: Option<bool>,
) -> Result<StatusReport, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("AMY-Loader/", env!("CARGO_PKG_VERSION")))
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let anisette_base = if anisette_server.starts_with("http") {
        anisette_server.trim_end_matches('/').to_string()
    } else {
        format!("https://{}", anisette_server.trim_end_matches('/'))
    };
    let anisette_host = anisette_base
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_string();

    let anisette_probe_url = format!("{anisette_base}/v3/client_info");
    let order = profile_order(&app);
    let first_profile = order[0];
    let (internet, gsa, anisette, developer, engine) = tokio::join!(
        probe(&client, "https://captive.apple.com/hotspot-detect.html"),
        gsa_probe(&client, first_profile),
        probe(&client, &anisette_probe_url),
        probe(&client, "https://developerservices2.apple.com/services/QH65B2/listTeams.action"),
        engine_item(&client, force.unwrap_or(false)),
    );

    let (login, install) = {
        let m = MEMORY.lock().unwrap();
        (m.login.clone(), m.install.clone())
    };

    let internet_item = internet_item(&internet);
    let offline = internet_item.state == Health::Down;
    let mut items = vec![
        internet_item,
        signin_item(&gsa, login.clone()),
        anisette_item(&anisette_host, &anisette, &login),
        developer_item(&developer),
        install_item(install),
        engine,
    ];
    if offline {
        // Every other probe fails for the same reason; don't cry wolf.
        for item in items.iter_mut().skip(1) {
            if item.state == Health::Down && item.at_ms.is_none() {
                item.state = Health::Unknown;
                item.summary = "Can't check while offline".into();
                item.fix = None;
            }
        }
    }

    Ok(StatusReport {
        items,
        checked_at_ms: now_ms(),
        identity: first_profile.label,
        engine_version: env!("CARGO_PKG_VERSION"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare() {
        assert!(parse_version("v2.4.3") > parse_version("2.4.2"));
        assert_eq!(parse_version("v2.4"), Some((2, 4, 0)));
        assert!(parse_version("v2.10.0") > parse_version("2.9.9"));
        assert_eq!(parse_version("nonsense"), None);
    }

    #[test]
    fn worst_state_wins() {
        assert!(Health::Blocked > Health::Down);
        assert!(Health::Down > Health::Warn);
        assert!(Health::Warn > Health::Unknown);
        assert!(Health::Unknown > Health::Ok);
    }

    #[test]
    fn profiles_have_unique_ids_and_upstream_default_first() {
        let mut ids: Vec<_> = PROFILES.iter().map(|p| p.id).collect();
        assert_eq!(ids[0], "mac-10.12");
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), PROFILES.len());
    }

    #[test]
    fn detects_grandslam_503_in_report_text() {
        let report = rootcause::report!(
            "HTTP status server error (503 Service Temporarily Unavailable) for url (https://gsa.apple.com/grandslam/GsService2)"
        );
        assert!(grandslam_unavailable(&report.into_dynamic()));
        let other = rootcause::report!("HTTP status client error (401 Unauthorized) for url (https://gsa.apple.com/grandslam/GsService2)");
        assert!(!grandslam_unavailable(&other.into_dynamic()));
    }
}
