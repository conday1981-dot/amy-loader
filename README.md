# A.M.Y Loader

A.M.Y Loader is the A.M.Y ecosystem's iPhone sideloader for Windows: sign in with an Apple ID, pick a phone, drop in an `.ipa`. It tracks what's installed on each phone with a 7-day countdown, remembers which Apple ID each phone uses, and **re-signs apps automatically over home Wi-Fi before they expire**, so the weekly reinstall goes away. It updates itself from A.M.Y's own signed feed.

It's a reskin of **[iloader](https://github.com/nab138/iloader) by nab138** (MIT). The Rust engine (Apple sign-in, anisette, signing, installing) is iloader's, unchanged; A.M.Y Loader replaces the interface. **A.M.Y Loader is not affiliated with or endorsed by iloader.**

## What's different from iloader

- A.M.Y holographic theme and layout (matches the A.M.Y hub), fonts bundled locally.
- **This week** timeline: every app on every phone with its signing countdown, re-sign (↻) and stop-tracking (×) buttons.
- Phone cards show Wi-Fi/USB, iOS version and the Apple ID that phone usually uses, with a one-tap switch.
- Drag an `.ipa` — or a `.zip` with one inside, such as a GitHub Actions artifact — anywhere onto the window (`Ctrl+O` to choose one). It's saved into the **Library** first, then installed if a phone and Apple ID are selected.
- **Live install progress**: a dock shows each install's stage (Connect → Sign → Upload → Install), percentage, bytes and speed while uploading, elapsed time and an estimate of the time left. Estimates learn from previous installs (USB and Wi-Fi speeds are kept separately). Auto-refresh and library updates show there too.
- **Library with updates**: every app is kept in A.M.Y's own folder (newest two versions, older ones deleted). Give an app an update source — GitHub releases, a GitHub Actions build (private repos with a token), an AltStore/SideStore source, or a direct link — and A.M.Y checks it every 6 hours, downloads newer versions (compared by version, then build number), and points re-signs at the new copy. With "install as soon as they download" on, it installs the update on the phones that have the app straight away.
- iloader's SideStore/LiveContainer installers and tools (certificates, App IDs, pairing files, settings, logs) live under **Advanced**.
- **Auto-refresh**: every 5 minutes it looks for apps within 2 days (adjustable) of expiring and, for each phone it can reach over Wi-Fi or USB, signs in with that app's Apple ID and re-installs the same `.ipa`. Failures back off; if a phone stays unreachable as expiry gets close, it says so.
- **Runs in the background**: starts with Windows hidden in the tray; closing the window keeps it running (tray menu: Open / Refresh apps now / Quit). One copy at a time.
- **Phone alerts** through [ntfy](https://ntfy.sh) (optional): refreshed, couldn't refresh, connect your phone, Apple wants a 2FA code. Alerts name the app and phone, never the Apple ID.
- **Track an installed app**: add an app that's already on a phone (from iloader, Sideloadly…) without reinstalling it.
- **Self-update** from A.M.Y's feed on Cloudflare, signed with A.M.Y's key (iloader's updater, which would install plain iloader, stays off).

## Where data lives (all on this PC)

| Data | Where |
| --- | --- |
| Apple ID passwords, certificates, anisette state | Windows Credential Manager, under `iloader` (shared with iloader, so saved logins carry over) |
| Saved login list, settings | `%APPDATA%\uk.amy.loader\data.json`, `preferences.json` |
| Install history, auto-refresh settings, activity log | `%APPDATA%\uk.amy.loader\amy.json` |
| Start with Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `AMY Loader` (only while "Run in the background" is on) |
| `.ipa` files | `%APPDATA%\uk.amy.loader\library\<bundle id>\` (index: `library.json`); records made before 1.2 may still point at the original file |
| Install-time estimates | `amy.json` → `timings` |
| GitHub token (optional, for private repos / Actions artifacts) | Windows Credential Manager, under `uk.amy.loader` |

Nothing is sent anywhere except to Apple (sign-in, signing), the anisette server chosen in Settings, the ntfy server if phone alerts are on, the update feed (a version check), and the update sources you set for library apps (GitHub, AltStore sources or links).

## Auto-refresh: what it needs

- The laptop on, A.M.Y Loader running (it starts with Windows), and the phone on the same Wi-Fi.
- Each phone paired for Wi-Fi once: plug it in by cable, open iTunes (or Apple Devices), and tick **Sync with this iPhone over Wi-Fi**.
- iPhones only stay visible over Wi-Fi while awake or charging, so starting 2 days early gives many chances; leaving a phone on charge overnight is the most reliable.
- The `.ipa` kept where it was installed from, and the Apple ID saved in A.M.Y Loader.

## Update feed

CI publishes each signed build of `main` to a static Cloudflare Worker (`updates/wrangler.toml`): the installer plus `latest.json`, at the endpoint in `src-tauri/amy.conf.json`. The app only installs an update whose signature matches the public key in that file. Bump `version` in `src-tauri/amy.conf.json` to release; the same version is never offered twice. The repository needs four Actions secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `CLOUDFLARE_API_TOKEN` (Edit Cloudflare Workers) and `CLOUDFLARE_ACCOUNT_ID`. Without the signing pair the build still works but publishes no update.

## Building

Builds run on GitHub Actions (`.github/workflows/build-windows.yml`): every push to `main` produces an installer artifact, and publishing a release attaches it. Locally:

```sh
bun i
bunx tauri build --config src-tauri/amy.conf.json --bundles nsis
```

## Keeping the engine current

All A.M.Y-specific files sit apart from iloader's: `src/amy/`, `src-tauri/src/amy.rs` (tray, start with Windows, notifications), `src-tauri/src/amy_install.rs` (install with live progress — the same steps as isideload's `install_app`, run one by one so each reports progress), `src-tauri/src/amy_library.rs` (library, update sources), `src-tauri/amy.conf.json` (name, ID, window, icons, update feed; layered over iloader's `tauri.conf.json` at build time), `src-tauri/amy-icons/` and `updates/`. The iloader files changed are `src/App.tsx`, `src/Device.tsx`, `src/main.tsx` and `index.html`, plus a few lines in `src-tauri/src/lib.rs` and `src-tauri/Cargo.toml` (three plugins, pinned to versions that match iloader's Tauri version) and `Cargo.lock`.

`.github/workflows/sync-upstream.yml` checks iloader every Monday. If iloader's new commits merge cleanly (a `Cargo.lock` conflict is settled automatically) it opens a pull request, and if they don't it opens an issue listing what conflicted. To do it by hand:

```sh
git remote add upstream https://github.com/nab138/iloader.git   # once
git fetch upstream
git merge upstream/main
```

Then update `UPSTREAM_ENGINE_VERSION` in `src/amy/meta.ts`.

## Licence

iloader's source is MIT (see `LICENSE`, © nab138), and that licence carries over to this fork. iloader's name and logos are covered separately by `LICENSE-BRANDING`; A.M.Y Loader uses its own name and icons. Exo 2 and Share Tech Mono are SIL OFL 1.1 (licences in `src/amy/fonts/`).
