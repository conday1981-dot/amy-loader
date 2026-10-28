# A.M.Y Loader

A.M.Y Loader is the A.M.Y ecosystem's iPhone sideloader for Windows: sign in with an Apple ID, pick a phone, drop in an `.ipa`. It tracks what's installed on each phone with a 7-day countdown, re-signs an app in one tap, and remembers which Apple ID each phone uses.

It's a reskin of **[iloader](https://github.com/nab138/iloader) by nab138** (MIT). The Rust engine (Apple sign-in, anisette, signing, installing) is iloader's, unchanged; A.M.Y Loader replaces the interface. **A.M.Y Loader is not affiliated with or endorsed by iloader.**

## What's different from iloader

- A.M.Y holographic theme and layout (matches the A.M.Y hub), fonts bundled locally.
- **This week** timeline: every app on every phone with its signing countdown, re-sign (↻) and stop-tracking (×) buttons.
- Phone cards show Wi-Fi/USB, iOS version and the Apple ID that phone usually uses, with a one-tap switch.
- Drag an `.ipa` anywhere onto the window to install it (`Ctrl+O` to choose one).
- iloader's SideStore/LiveContainer installers and tools (certificates, App IDs, pairing files, settings, logs) live under **Advanced**.
- iloader's self-updater is switched off (it would install plain iloader). A.M.Y's own update feed comes with Phase 2.

## Where data lives (all on this PC)

| Data | Where |
| --- | --- |
| Apple ID passwords, certificates, anisette state | Windows Credential Manager, under `iloader` (shared with iloader, so saved logins carry over) |
| Saved login list, settings | `%APPDATA%\uk.amy.loader\data.json`, `preferences.json` |
| Install history (timeline) | `%APPDATA%\uk.amy.loader\amy.json` |
| `.ipa` files | wherever you keep them; A.M.Y Loader stores the path to re-sign later |

Nothing is sent anywhere except to Apple (sign-in, signing) and the anisette server chosen in Settings.

## Building

Builds run on GitHub Actions (`.github/workflows/build-windows.yml`): every push to `main` produces an installer artifact, and publishing a release attaches it. Locally:

```sh
bun i
bunx tauri build --config src-tauri/amy.conf.json --bundles nsis
```

## Keeping the engine current

All A.M.Y-specific files sit apart from iloader's: `src/amy/`, `src-tauri/amy.conf.json` (name, ID, window, icons; layered over iloader's `tauri.conf.json` at build time) and `src-tauri/amy-icons/`. The only iloader files changed are `src/App.tsx`, `src/Device.tsx`, `src/main.tsx` and `index.html`.

`.github/workflows/sync-upstream.yml` checks iloader every Monday. If iloader's new commits merge cleanly it opens a pull request, and if they don't it opens an issue listing what conflicted. To do it by hand:

```sh
git remote add upstream https://github.com/nab138/iloader.git   # once
git fetch upstream
git merge upstream/main
```

Then update `UPSTREAM_ENGINE_VERSION` in `src/amy/meta.ts`.

## Licence

iloader's source is MIT (see `LICENSE`, © nab138), and that licence carries over to this fork. iloader's name and logos are covered separately by `LICENSE-BRANDING`; A.M.Y Loader uses its own name and icons. Exo 2 and Share Tech Mono are SIL OFL 1.1 (licences in `src/amy/fonts/`).
