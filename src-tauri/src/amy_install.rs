//! A.M.Y Loader: install with live progress.
//!
//! iloader's `sideload_operation` calls isideload's all-in-one
//! `Sideloader::install_app`, which only *logs* transfer progress. This module
//! runs the same four steps itself (register phone → sign → upload → install)
//! so every step can report progress to the window:
//!
//!   event `amy://install-progress` → { jobId, stage, label, overall, stage_progress,
//!                                     bytes_done, bytes_total }
//!
//! It also emits the usual `operation_amy_sideload` started/finished/failed
//! updates so the existing error screen (with iloader's suggestions) still works.
//! iloader's own `sideload.rs` is untouched.

use std::path::{Path, PathBuf};

use isideload::{
    dev::devices::DevicesApi, sideload::install::install_app as transfer_and_install,
    util::device::IdeviceInfo,
};
use serde::Serialize;
use tauri::{Emitter, Manager, State, Window};

use crate::{
    device::{DeviceInfoMutex, get_provider},
    error::AppError,
    operation::Operation,
    sideload::{SideloaderGuard, SideloaderMutex},
};

pub const PROGRESS_EVENT: &str = "amy://install-progress";

/// Share of the overall bar each stage owns. Upload dominates on Wi-Fi.
const CONNECT: (f64, f64) = (0.00, 0.06);
const SIGN: (f64, f64) = (0.06, 0.30);
const UPLOAD: (f64, f64) = (0.30, 0.86);
const INSTALL: (f64, f64) = (0.86, 1.00);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub job_id: String,
    /// connect | sign | upload | install | done
    pub stage: &'static str,
    /// Human description of what is happening right now.
    pub label: String,
    /// 0..1 across the whole job.
    pub overall: f64,
    /// 0..1 within the current stage.
    pub stage_progress: f64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

#[derive(Clone)]
struct Reporter {
    window: Window,
    job_id: String,
}

impl Reporter {
    fn emit(&self, stage: &'static str, label: impl Into<String>, span: (f64, f64), stage_progress: f64, bytes: (u64, u64)) {
        let p = stage_progress.clamp(0.0, 1.0);
        let _ = self.window.emit(
            PROGRESS_EVENT,
            InstallProgress {
                job_id: self.job_id.clone(),
                stage,
                label: label.into(),
                overall: span.0 + (span.1 - span.0) * p,
                stage_progress: p,
                bytes_done: bytes.0,
                bytes_total: bytes.1,
            },
        );
    }
}

/// What isideload's signing callback values mean (see sideloader.rs / sign.rs).
fn sign_label(value: f32) -> (&'static str, f64) {
    match value {
        v if v < 0.12 => ("Certificate ready", 0.15),
        v if v < 0.17 => ("App ID registered", 0.30),
        v if v < 0.25 => ("Provisioning profile downloaded", 0.45),
        v if v < 0.35 => ("Preparing the app bundle", 0.60),
        v if v < 0.45 => ("Signing the app", 0.75),
        _ => ("Signing frameworks and extensions", 0.90),
    }
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            match entry.metadata() {
                Ok(m) if m.is_dir() => total += dir_size(&p),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

async fn run(
    device_state: &State<'_, DeviceInfoMutex>,
    sideloader_state: &State<'_, SideloaderMutex>,
    app_path: PathBuf,
    report: Reporter,
) -> Result<(), AppError> {
    let device = {
        let lock = device_state.lock().unwrap();
        match &*lock {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };

    report.emit("connect", format!("Connecting to {}", device.info.name), CONNECT, 0.1, (0, 0));
    let provider = get_provider(&device.info).await?;
    let mut guard = SideloaderGuard::take(sideloader_state)?;
    let sideloader = guard.get_mut();

    let info = IdeviceInfo::from_device(&provider).await?;
    report.emit("connect", "Checking the phone is registered with your Apple ID", CONNECT, 0.5, (0, 0));
    let team = sideloader.get_team().await?;
    sideloader
        .get_dev_session()
        .ensure_device_registered(&team, &info.name, &info.udid, None)
        .await?;

    report.emit("sign", "Requesting a signing certificate", SIGN, 0.02, (0, 0));
    let sign_report = report.clone();
    let (signed_path, _special) = sideloader
        .sign_app(
            app_path,
            Some(team),
            true, // increased memory limit, as iloader does
            Some(move |value: f32| {
                let r = sign_report.clone();
                async move {
                    let (label, p) = sign_label(value);
                    r.emit("sign", label, SIGN, p, (0, 0));
                }
            }),
            Some(&device.pairing),
            Some(&info.udid),
        )
        .await?;

    // isideload reports 0–70 while uploading and 70–100 while the phone installs.
    let total = dir_size(&signed_path).max(1);
    report.emit("upload", "Sending the app to the phone", UPLOAD, 0.0, (0, total));
    let transfer_report = report.clone();
    let result = transfer_and_install(&provider, &signed_path, move |pct: u64| {
        let pct = pct.min(100) as f64;
        if pct < 70.0 {
            let p = pct / 70.0;
            let done = (total as f64 * p) as u64;
            transfer_report.emit("upload", "Sending the app to the phone", UPLOAD, p, (done, total));
        } else {
            let p = (pct - 70.0) / 30.0;
            transfer_report.emit("install", "iPhone is installing", INSTALL, p, (total, total));
        }
    })
    .await;

    // isideload deletes its signed copy by default; do the same here.
    let _ = std::fs::remove_dir_all(&signed_path);
    result?;

    report.emit("done", "Installed", (1.0, 1.0), 1.0, (total, total));
    Ok(())
}

/// Install (or re-sign) an .ipa on the selected phone, reporting live progress.
#[tauri::command]
pub async fn amy_sideload_operation(
    window: Window,
    device_state: State<'_, DeviceInfoMutex>,
    sideloader_state: State<'_, SideloaderMutex>,
    app_path: String,
    job_id: String,
) -> Result<(), AppError> {
    let op = Operation::new("amy_sideload".to_string(), &window);
    op.start("install")?;
    let reporter = Reporter { window: window.clone(), job_id };
    let result = run(&device_state, &sideloader_state, PathBuf::from(app_path), reporter).await;
    crate::amy_status::note_install_result(window.app_handle(), &result);
    op.fail_if_err("install", result)?;
    op.complete("install")?;
    Ok(())
}
