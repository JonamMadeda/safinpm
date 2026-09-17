# safinpm — Architecture & App Details

> Windows desktop app (Tauri v2 + React) that finds stale `node_modules` folders
> and moves them to the Recycle Bin to reclaim disk space. Nothing is ever
> permanently deleted.

## 1. What the app does (user-facing features)

### Core workflow
1. **Select Folder** — native folder picker (`@tauri-apps/plugin-dialog`), e.g. `C:\dev`.
2. **Streaming scan** — projects appear live as rows while the Rust backend walks the
   tree in parallel, with a `walk → measure` progress bar and **Cancel scan**.
   Cancelling keeps the partial results found so far.
3. **Ranked table** — sorted oldest-first by *last activity*, showing Project,
   Last active, Size, Status, and per-row actions.
4. **Clean** — single-row or bulk (checkboxes + select-all) deletion to the
   **Windows Recycle Bin**, with a confirm dialog and a `Freed X across N projects` toast.

### Discovery details
- Detects any directory containing `package.json` (skips `node_modules`, `.git`,
  `target`, `.next`, `dist`, `build`, `.turbo`, `.parcel-cache`, …).
- **Package-manager badges**: `packageManager` field wins, otherwise lockfiles
  (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lock[b]`).
- **Size estimates**: pnpm/bun installs are link-based (global store), so sizes show
  `~` with a tooltip — the sum overstates real disk use.
- **Yarn PnP**: rows show `PnP` instead of `cleaned` (nothing to delete by design).
- **Monorepos**: roots detected via `workspaces` key or `pnpm-workspace.yaml`;
  members get an `in <root>` badge, roots a cyan badge, plus an `In workspace` filter.

### Last-active ranking (and the atime bug it survived)
- Uses **modification time only** (`max` over `package.json`, `src/`, lockfiles,
  project dir, plus last-install markers like `.package-lock.json` /
  `.modules.yaml` / `.yarn-state.yml` / `.pnp.*`).
- `accessed()` is deliberately **not** used: the scan itself walks every directory,
  which bumps access times on systems with NTFS atime tracking — every project
  then reported “just now”. Covered by regression test
  `last_active_follows_mtime_and_survives_a_scan`.

### Safety features
- Deletion = `trash::delete` → Recycle Bin. Restore from there if needed.
- Rust enforces: only folders literally named `node_modules` are deletable
  (single + every batch item).
- **Active-project warning** in bulk confirm when selections were touched < 3 months ago.
- **Dev-server detection** (`check_processes` via `sysinfo`): warns with
  `name (pid)` if node/bun/deno runs with cwd inside a target project.
- **Ignore list** (persisted): eye-off button hides projects from scans; Unignore panel.
- Bulk deletes return **per-item results** — one failure never aborts the rest.

### Everyday UX
- Search (name/path) + filter chips: All / Cleanable / Cleaned / Stale >3mo /
  In workspace (all with counts). Select-all respects the active filter.
- Reveal in Explorer, Copy path per row.
- **Persistence** (`store.json` in app-data): last folder (one-click rescan on
  launch), cached scan results with a “cached from …” banner, lifetime
  **Freed all-time** counter.
- Modal: Esc / backdrop-click to close, autofocused Cancel.
- Status pills: `Inactive > 6 months` (red), `Stale > 3 months` (amber), `Active` (green).

## 2. Tech stack

| Layer    | Tech |
|----------|------|
| Shell    | Tauri v2 (`tauri`, `tauri-build`), window 1100×720 |
| Backend  | Rust 2021: `jwalk` (parallel walk), `trash` (Recycle Bin), `serde/serde_json`, `rand` (row ids), `sysinfo` (process scan), `tauri-plugin-dialog` |
| Frontend | React 18 + TypeScript, Vite (dev on `:1420`), Tailwind CSS 3, `lucide-react`, `@tauri-apps/api`, `@tauri-apps/plugin-dialog` |
| Packaging| NSIS (`safinpm_*_x64-setup.exe`) + portable exe; custom SVG→PNG/ICO/ICNS icon set |
| Tests    | Rust unit tests (`cargo test`), `tsc --noEmit`, `vite build` |

## 3. Repository structure

```
safinpm/
├── README.md                    # user-facing intro + dev commands
├── docs/ARCHITECTURE.md         # this file
├── package.json                 # React deps + tauri CLI; scripts: dev/build/tauri
├── vite.config.ts               # React plugin, strict port 1420 (matches tauri devUrl)
├── tailwind.config.js / postcss.config.js
├── tsconfig.json / index.html
├── src/
│   ├── main.tsx                 # React root mount
│   ├── App.tsx                  # THE entire UI (~700 lines): dashboard, table,
│   │                            # selection, modals, toasts, store loading, scan events
│   ├── styles.css               # Tailwind directives + slate-900 base
│   └── vite-env.d.ts
└── src-tauri/
    ├── Cargo.toml               # backend deps (see §2)
    ├── Cargo.lock               # committed for reproducible builds
    ├── build.rs                 # tauri_build::build()
    ├── tauri.conf.json          # app id com.safinpm.app, devUrl/frontendDist,
    │                            # window size, bundle targets ["nsis"]
    ├── capabilities/default.json# core:default + dialog:allow-open
    ├── icons/                   # 32px, 128px, 256px PNGs + icon.ico + icon.icns
    └── src/main.rs              # ALL backend logic + tests (~750 lines)
```

Single-file backend and single-file UI are deliberate at this size: every command
and every component is reachable without cross-file navigation.

## 4. Backend reference (`src-tauri/src/main.rs`)

### Data shapes (all `camelCase` over the bridge)
- `ProjectInfo` — `id` (6-char mixed-case, e.g. `aB1cD2`), `projectName`,
  `projectPath`, `nodeModulesPath?`, `sizeBytes`, `sizeEstimate`,
  `packageManager`, `usesPnp`, `workspaceRoot?`, `isWorkspaceRoot`,
  `lastActiveTimestamp` (unix seconds).
- `BatchDeleteResult` — `path`, `freedBytes?`, `error?`.
- `ScanProgress` — `phase` (`walk`|`measure`), `done`, `total`.
- `ProcessHit` — `path`, `pid`, `name`.
- `Store` — `ignoredPaths[]`, `lastFolder?`, `lastScan? {folder, scannedAt, projects}`,
  `totalFreedBytes` (JSON file, pretty-printed).

### Commands
| Command | Input → Output | Notes |
|---|---|---|
| `scan_directory` | `path` → `ProjectInfo[]` (sorted oldest-first) | Streams `safinpm-scan-project` per row + `safinpm-scan-progress`; returns partial list if cancelled |
| `cancel_scan` | — | Sets `SCAN_CANCELLED: AtomicBool`; walker prunes via `children.clear()` |
| `delete_node_modules` | `path` → freed bytes | Single-item wrapper |
| `delete_node_modules_batch` | `paths[]` → `BatchDeleteResult[]` | Order-preserving, failures isolated |
| `check_processes` | `paths[]` → `ProcessHit[]` | `sysinfo` snapshot with `exe`+`cwd` refresh; matches node/bun/deno by exe name + cwd prefix |
| `reveal_in_explorer` | `path` | `explorer /select,<path>` (Windows-only by design) |
| `get_store` / `set_ignored_paths` / `save_scan` / `record_freed` | — | `store.json` CRUD; corrupt/missing file → defaults |

### Key algorithms
- **Walk**: `jwalk` parallel traversal with `process_read_dir` pruning (emits walk
  progress every 500 dirs; aborts fast on cancel). `package.json` files under any
  `node_modules` component are ignored.
- **Workspace pre-pass**: one `package.json` read per project (cached in a map),
  roots collected, then nearest-ancestor lookup bounded by the scan root.
- **Sizing**: second `jwalk` pass over `node_modules` summing file lengths.
- **Threading note**: the walk closure only captures owned values (`Arc`, cloned
  `AppHandle`) because it runs on worker threads (`Send + 'static`).

## 5. Frontend reference (`src/App.tsx`)

### State groups
- Data: `projects`, `folder`, `scanning`, `scanProgress`, `error`, `toast`.
- Selection: `selected: Set<id>`, `pendingDelete`, `pendingBulk`, `deleting`, `inUse`.
- Filtering: `query`, `chip`, `ignored: Set<path>`, `showIgnored`.
- Persistence: `lastFolder`, `cachedAt`, `cacheBanner`, `totalFreed`.

### Data flow
- Mount: registers `listen("safinpm-scan-progress" | "safinpm-scan-project")`,
  then `get_store()` → restores ignore list, lifetime total, last folder, cached scan.
- `runScan`: clears rows, streams live rows via events, reconciles with the sorted
  return value, `save_scan`s on success, restores previous rows on failure.
- Deletes: invoke → map results onto `projects` (cleared rows), `record_freed`,
  toast; selection pruned accordingly.

### Formatting helpers
`formatBytes` (B→TB), `timeAgo` (“3 months ago”), `statusFor` (pill classes),
`isStale` (>90d, shared by chip + bulk warning).

## 6. Persistence & privacy
- Only `store.json` under the app-data dir: ignored paths, last folder, last full
  scan (project metadata only — no file contents), lifetime freed bytes.
- No telemetry, no network calls. Clipboard use is local-only.

## 7. Build, test, release
```powershell
npm install
npm run tauri dev        # Vite :1420 + debug Rust (auto-rebuild/HMR)
cargo test               # in src-tauri/ — 7 unit tests (scan signal, batch,
                         # PM detection, workspaces, store, process checks)
npx tsc --noEmit; npm run build
npm run tauri build      # release exe + NSIS setup → src-tauri/target/release/bundle/
```
- Release flow: bump `0.1.0` in `package.json` + `tauri.conf.json` + `Cargo.toml`,
  commit, build, `gh release create vX.Y.Z <setup.exe> <portable.exe>`.
- Requires NSIS 3 (`winget install -e --id NSIS.NSIS`); build shell needs
  `makensis` on PATH (`C:\Program Files (x86)\NSIS`).

## 8. Known limitations / ideas
- Sizes count hardlinked pnpm/bun files at face value (`~` flag) — could resolve
  via link counting later.
- `check_processes` is heuristic (cwd match); containers/WSL runtimes aren’t seen.
- No auto-updater yet (`tauri-plugin-updater` is the natural next step).
- `dist/` and `target/` are gitignored build outputs; `Cargo.lock` is committed.
