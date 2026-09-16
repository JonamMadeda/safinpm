# safinpm

Find stale `node_modules` folders and reclaim disk space — safely.

safinpm scans a folder for Node.js projects, ranks them by **last activity** (oldest first),
measures each `node_modules`, and lets you move them to the **Windows Recycle Bin** —
nothing is ever permanently deleted.

## Download

Get the Windows installer from the [**latest release**](https://github.com/JonamMadeda/safinpm/releases/latest)
(`safinpm_*_x64-setup.exe`). Requires Windows 10/11 (WebView2 included with Windows 11
and recent Windows 10).

## Features

- ⚡ Parallel recursive scan (jwalk) for `package.json` projects
- 🕒 Last-active ranking via file modification times (immune to scan-induced atime changes),
      including last-`npm install` signals for npm, pnpm, yarn, and bun
- 📦 Package-manager detection (npm / pnpm / yarn / bun), Yarn PnP awareness,
      link-store size estimates, workspace/monorepo badges
- ✅ Single + bulk clean with per-item results
- 🛡️ Safety: Recycle Bin only (Rust `trash` crate), active-project warnings,
      dev-server detection, pin/ignore list
- 🔍 Search + filters, live scan progress with cancel, cached results,
      Explorer reveal, lifetime "freed" counter

## Develop

```powershell
npm install
npm run tauri dev      # dev window (Vite + Rust)
npm run tauri build    # release .exe + NSIS setup in src-tauri/target/release/bundle/
```

Backend commands live in `src-tauri/src/main.rs` (`scan_directory`, `delete_node_modules`,
`delete_node_modules_batch`, `check_processes`, …) with unit tests: `cargo test` in `src-tauri/`.

## Safety model

- Deletion = move to Recycle Bin. Restore from there if you change your mind.
- Only folders literally named `node_modules` are ever deleted (enforced in Rust).
- Reinstall anytime with `npm install` / `pnpm install` / `yarn` / `bun install`.
