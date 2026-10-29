//! A.M.Y Loader additions to the iloader engine (Phase 2).
//!
//! Kept in this one file so iloader's own modules stay as upstream ships them:
//!  - single instance: launching again focuses the running copy (so the
//!    background copy started at login and a Start-menu launch never fight
//!    over the phone connection)
//!  - start with Windows (hidden, `--background`) via tauri-plugin-autostart
//!  - tray icon: closing the window hides it; tray menu opens / refreshes / quits
//!  - Windows notifications via tauri-plugin-notification
//!
//! The auto-refresh logic itself lives in the front end (src/amy/autorefresh.ts)
//! and drives iloader's existing commands, so the engine is unchanged.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_notification::NotificationExt;

/// Argument the login-time launch uses so the app starts hidden in the tray.
pub const BACKGROUND_ARG: &str = "--background";
/// Event the tray's "Refresh apps now" item sends to the front end.
pub const REFRESH_EVENT: &str = "amy://refresh-now";

/// When true, closing the window hides it to the tray instead of quitting.
/// The front end sets this from the saved setting as soon as it loads.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);
/** The "still running in the tray" hint is shown once per run. */
static TRAY_HINT_SHOWN: AtomicBool = AtomicBool::new(false);

/// Adds A.M.Y's plugins and window behaviour to the builder. Single-instance
/// must be the first plugin registered, so this wraps `Builder::default()`.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![BACKGROUND_ARG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                    if !TRAY_HINT_SHOWN.swap(true, Ordering::Relaxed) {
                        let _ = window
                            .app_handle()
                            .notification()
                            .builder()
                            .title("A.M.Y Loader is still running")
                            .body("It keeps your apps refreshed from the tray. Right-click the tray icon to quit.")
                            .show();
                    }
                }
            }
        })
}

/// Tray icon + start-hidden handling. Call from the builder's `setup`.
/// The main window is created hidden (amy.conf.json) and shown here unless the
/// app was started at login. A tray failure is logged, never fatal.
pub fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(e) = build_tray(app) {
        tracing::error!("A.M.Y tray icon unavailable: {e}");
        // without a tray, hiding on close would strand the app
        CLOSE_TO_TRAY.store(false, Ordering::Relaxed);
        TRAY_AVAILABLE.store(false, Ordering::Relaxed);
    }
    if !launched_in_background() || !TRAY_AVAILABLE.load(Ordering::Relaxed) {
        show_main(app.handle());
    }
    Ok(())
}

static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(true);

fn build_tray<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "amy_open", "Open A.M.Y Loader", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "amy_refresh", "Refresh apps now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "amy_quit", "Quit A.M.Y Loader", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &refresh, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("amy-tray")
        .tooltip("A.M.Y Loader")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "amy_open" => show_main(app),
            "amy_refresh" => {
                let _ = app.emit(REFRESH_EVENT, ());
            }
            "amy_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn launched_in_background() -> bool {
    std::env::args().any(|a| a == BACKGROUND_ARG)
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    autostart: bool,
    close_to_tray: bool,
    launched_in_background: bool,
}

#[tauri::command]
pub fn amy_get_background(app: AppHandle) -> Result<BackgroundState, String> {
    Ok(BackgroundState {
        autostart: app.autolaunch().is_enabled().map_err(|e| e.to_string())?,
        close_to_tray: CLOSE_TO_TRAY.load(Ordering::Relaxed),
        launched_in_background: launched_in_background(),
    })
}

/// Turn "start with Windows" and "close to tray" on or off together.
#[tauri::command]
pub fn amy_set_background(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let currently = launcher.is_enabled().map_err(|e| e.to_string())?;
    if enabled && !currently {
        launcher.enable().map_err(|e| e.to_string())?;
    } else if !enabled && currently {
        launcher.disable().map_err(|e| e.to_string())?;
    }
    CLOSE_TO_TRAY.store(enabled && TRAY_AVAILABLE.load(Ordering::Relaxed), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn amy_show_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
pub fn amy_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
