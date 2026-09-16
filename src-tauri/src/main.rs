// safinpm — Tauri v2 backend
// Scans for Node.js projects, ranks by last-active time, measures node_modules,
// and safely moves node_modules to the Windows Recycle Bin via `trash`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use jwalk::WalkDir;
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    id: String,
    project_name: String,
    project_path: String,
    node_modules_path: Option<String>,
    size_bytes: u64,
    /// True for link-based installs (pnpm/bun): node_modules mostly points
    /// into a global store, so the summed size overstates real disk use.
    size_estimate: bool,
    /// npm | pnpm | yarn | bun | unknown
    package_manager: String,
    /// Yarn PnP project (no node_modules by design).
    uses_pnp: bool,
    /// Path of the workspace root this project belongs to (None if standalone
    /// or if this project IS the root).
    workspace_root: Option<String>,
    is_workspace_root: bool,
    last_active_timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: String, // "walk" | "measure"
    done: usize,
    total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessHit {
    /// Project path the process runs in.
    path: String,
    pid: u32,
    name: String,
}

/// Persistent app store (~/AppData/Roaming/com.safinpm.app/store.json).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CachedScan {
    folder: String,
    scanned_at: i64,
    projects: Vec<ProjectInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    ignored_paths: Vec<String>,
    last_folder: Option<String>,
    last_scan: Option<CachedScan>,
    total_freed_bytes: u64,
}

/// Set by `cancel_scan`; checked by the running `scan_directory`.
static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Generate a 6-char mixed-case alphanumeric id, e.g. `aB1cD2`, `xYz78AbC`.
fn generate_id() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(6)
        .map(char::from)
        .collect()
}

fn system_time_to_unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read + parse package.json once per project; reused for package-manager
/// detection and workspace-root detection (cheap small-file read).
fn load_package_manifest(dir: &Path) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&content).ok()
}

/// Returns (manager, size_is_estimate, uses_pnp).
/// `packageManager` field wins; otherwise lockfiles decide.
fn detect_package_manager(dir: &Path, manifest: Option<&serde_json::Value>) -> (String, bool, bool) {
    if let Some(m) = manifest {
        if let Some(pm) = m.get("packageManager").and_then(|v| v.as_str()) {
            let name = pm.split('@').next().unwrap_or("").to_lowercase();
            if ["npm", "pnpm", "yarn", "bun"].contains(&name.as_str()) {
                return finish_manager(&name, dir);
            }
        }
    }
    // Lockfile fallback (checked in an order that prefers the more specific).
    for (file, name) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
    ] {
        if dir.join(file).is_file() {
            return finish_manager(name, dir);
        }
    }
    ("unknown".to_string(), false, false)
}

fn finish_manager(name: &str, dir: &Path) -> (String, bool, bool) {
    // pnpm/bun installs are link-based (global store) → summed size overstates.
    let estimate = matches!(name, "pnpm" | "bun");
    let pnp = name == "yarn"
        && [".pnp.cjs", ".pnp.loader.mjs", ".pnp.js"]
            .iter()
            .any(|f| dir.join(f).is_file());
    (name.to_string(), estimate, pnp)
}

/// A workspace root has a `workspaces` key in package.json or a
/// pnpm-workspace.yaml file next to it.
fn is_workspace_root(dir: &Path, manifest: Option<&serde_json::Value>) -> bool {
    if dir.join("pnpm-workspace.yaml").is_file() || dir.join("pnpm-workspace.yml").is_file() {
        return true;
    }
    match manifest.and_then(|m| m.get("workspaces")) {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Array(a)) => !a.is_empty(),
        Some(serde_json::Value::Object(o)) => !o.is_empty(),
        Some(_) => true,
    }
}

/// Nearest ancestor of `project_dir` (excluding itself) that is a known
/// workspace root, staying within `scan_root`.
fn find_workspace_root(
    project_dir: &Path,
    roots: &HashSet<PathBuf>,
    scan_root: &Path,
) -> Option<PathBuf> {
    project_dir
        .ancestors()
        .skip(1)
        .take_while(|a| a.starts_with(scan_root))
        .find(|a| roots.contains(*a))
        .map(|p| p.to_path_buf())
}
/// Best-effort "last active" timestamp for a project.
/// Uses `modified` time ONLY — never `accessed`.
///
/// Rationale (bug fix): the scan itself walks every directory, and on systems
/// with NTFS last-access tracking enabled that bumps each visited directory's
/// access time to scan time. Reading `accessed()` afterwards therefore reported
/// ~scan time for every project ("just now" across the board). Modification
/// times are unaffected by reads, so the signal stays stable across rescans.
///
/// Signals (max wins): package.json, src/, lockfiles, the project dir itself,
/// and node_modules/.package-lock.json (= last `npm install` time).
fn last_active_for_project(project_dir: &Path, package_json: &Path) -> i64 {
    let mut best: i64 = 0;

    let mut consider = |p: &Path| {
        if let Ok(meta) = std::fs::metadata(p) {
            if let Ok(m) = meta.modified() {
                best = best.max(system_time_to_unix_secs(m));
            }
        }
    };

    consider(package_json);
    consider(project_dir);
    consider(&project_dir.join("src"));
    consider(&project_dir.join("package-lock.json"));
    consider(&project_dir.join("pnpm-lock.yaml"));
    consider(&project_dir.join("yarn.lock"));
    consider(&project_dir.join("bun.lock"));
    consider(&project_dir.join("bun.lockb"));
    consider(&project_dir.join(".yarn-state.yml"));
    consider(&project_dir.join(".pnp.cjs"));
    consider(&project_dir.join(".pnp.loader.mjs"));
    consider(&project_dir.join("node_modules").join(".package-lock.json")); // npm: last install
    consider(&project_dir.join("node_modules").join(".modules.yaml")); // pnpm: last install

    best
}

/// Recursively sum file sizes under `dir` using a parallel walker.
fn dir_size_bytes(dir: &Path) -> u64 {
    WalkDir::new(dir)
        .skip_hidden(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Abort a running `scan_directory`. The scan checks this flag while walking
/// and between projects, then returns whatever it found so far.
#[tauri::command]
fn cancel_scan() {
    SCAN_CANCELLED.store(true, Ordering::SeqCst);
}

fn scan_cancelled() -> bool {
    SCAN_CANCELLED.load(Ordering::SeqCst)
}

fn emit_progress(app: &AppHandle, phase: &str, done: usize, total: usize) {
    let _ = app.emit(
        "safinpm-scan-progress",
        ScanProgress {
            phase: phase.to_string(),
            done,
            total,
        },
    );
}

#[tauri::command]
fn scan_directory(app: AppHandle, path: String) -> Result<Vec<ProjectInfo>, String> {
    SCAN_CANCELLED.store(false, Ordering::SeqCst);

    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    // Phase 1: find every `package.json` under root, skipping heavy dirs.
    // jwalk visits in parallel; the closure prunes traversal. Everything the
    // closure touches is owned ('static) because it may run on worker threads.
    let visited_dirs = std::sync::Arc::new(AtomicUsize::new(0));
    let walk_app = app.clone();
    let package_jsons: Vec<PathBuf> = WalkDir::new(&root)
        .skip_hidden(false)
        .process_read_dir(move |_, _, _, children| {
            if scan_cancelled() {
                children.clear(); // stop the walk ASAP
                return;
            }
            let n = visited_dirs.fetch_add(1, Ordering::Relaxed);
            if n % 500 == 0 {
                emit_progress(&walk_app, "walk", n, 0);
            }
            children.retain(|dir_entry_result| {
                if let Ok(dir_entry) = dir_entry_result {
                    let name = dir_entry.file_name().to_string_lossy().to_lowercase();
                    // Prune dirs we never want to search inside.
                    if dir_entry.file_type().is_dir() {
                        return !matches!(
                            name.as_str(),
                            "node_modules" | ".git" | "target" | ".svn" | ".hg" | ".next" | "dist" | "build" | ".turbo" | ".parcel-cache"
                        );
                    }
                }
                true
            });
        })
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.file_name().to_string_lossy() == "package.json")
        // Guard: ignore package.json files that live *inside* a node_modules tree
        // (in case the user scanned a dir that already contains one at top level).
        .filter(|e| {
            !e.path()
                .components()
                .any(|c| c.as_os_str().to_string_lossy() == "node_modules")
        })
        .map(|e| e.path())
        .collect();

    if scan_cancelled() {
        return Ok(Vec::new());
    }

    let total = package_jsons.len();

    // Pre-pass: which project dirs are workspace roots?
    let mut manifests: HashMap<PathBuf, Option<serde_json::Value>> = HashMap::new();
    let mut roots: HashSet<PathBuf> = HashSet::new();
    for package_json in &package_jsons {
        if let Some(project_dir) = package_json.parent() {
            let manifest = load_package_manifest(project_dir);
            if is_workspace_root(project_dir, manifest.as_ref()) {
                roots.insert(project_dir.to_path_buf());
            }
            manifests.insert(project_dir.to_path_buf(), manifest);
        }
    }

    // Phase 2: metadata + size per project, streamed live to the frontend.
    let mut projects = Vec::with_capacity(total);
    for (i, package_json) in package_jsons.iter().enumerate() {
        if scan_cancelled() {
            break;
        }
        let project_dir = match package_json.parent() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let project_name = project_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let manifest = manifests.remove(&project_dir).flatten();
        let (package_manager, size_estimate, uses_pnp) =
            detect_package_manager(&project_dir, manifest.as_ref());
        let is_root = roots.contains(&project_dir);
        let workspace_root = if is_root {
            None
        } else {
            find_workspace_root(&project_dir, &roots, &root)
                .map(|p| p.to_string_lossy().to_string())
        };

        let node_modules = project_dir.join("node_modules");
        let (node_modules_path, size_bytes) = if node_modules.is_dir() {
            let size = dir_size_bytes(&node_modules);
            (
                Some(node_modules.to_string_lossy().to_string()),
                size,
            )
        } else {
            (None, 0)
        };

        let info = ProjectInfo {
            id: generate_id(), // e.g. aB1cD2
            project_name,
            project_path: project_dir.to_string_lossy().to_string(),
            node_modules_path,
            size_bytes,
            size_estimate,
            package_manager,
            uses_pnp,
            workspace_root,
            is_workspace_root: is_root,
            last_active_timestamp: last_active_for_project(&project_dir, package_json),
        };
        // Live row for the UI; failures to emit are non-fatal.
        let _ = app.emit("safinpm-scan-project", &info);
        if i % 5 == 0 || i + 1 == total {
            emit_progress(&app, "measure", i + 1, total);
        }
        projects.push(info);
    }

    // Oldest (least recently active) first — best cleanup candidates on top.
    // (Live-emitted rows arrive unsorted; the final return is the sorted truth.)
    projects.sort_by_key(|p| p.last_active_timestamp);
    Ok(projects)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchDeleteResult {
    path: String,
    freed_bytes: Option<u64>,
    error: Option<String>,
}

/// Shared implementation: validate + measure + move one folder to the trash.
fn move_node_modules_to_trash(path: &str) -> Result<u64, String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    // Safety guard: only allow deleting folders literally named `node_modules`.
    let is_node_modules = target
        .file_name()
        .map(|n| n.to_string_lossy() == "node_modules")
        .unwrap_or(false);
    if !is_node_modules {
        return Err("Refusing to delete: path is not a node_modules folder".to_string());
    }
    if !target.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let freed = dir_size_bytes(&target);

    // Move to Windows Recycle Bin (NOT permanent fs::remove_dir_all).
    trash::delete(&target).map_err(|e| format!("Failed to move to Recycle Bin: {e}"))?;

    Ok(freed)
}

#[tauri::command]
fn delete_node_modules(path: String) -> Result<u64, String> {
    move_node_modules_to_trash(&path)
}

/// Bulk variant: one result per input path, in order. Individual failures
/// don't abort the batch — each item carries its own `freedBytes` or `error`.
#[tauri::command]
fn delete_node_modules_batch(paths: Vec<String>) -> Vec<BatchDeleteResult> {
    paths
        .into_iter()
        .map(|path| match move_node_modules_to_trash(&path) {
            Ok(freed) => BatchDeleteResult {
                path,
                freed_bytes: Some(freed),
                error: None,
            },
            Err(e) => BatchDeleteResult {
                path,
                freed_bytes: None,
                error: Some(e),
            },
        })
        .collect()
}

fn is_js_runtime(exe_file_name: &str) -> bool {
    matches!(
        exe_file_name,
        "node" | "node.exe" | "bun" | "bun.exe" | "deno" | "deno.exe"
    )
}

/// Find JS runtimes whose current working directory is inside one of `paths`.
/// Used to warn before recycling a node_modules that a dev server or install
/// may still be using. Heuristic, not a lock — deletion stays user-confirmed.
fn find_processes_in(paths: &[String]) -> Vec<ProcessHit> {
    let targets: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    if targets.is_empty() {
        return Vec::new();
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );
    let mut hits = Vec::new();
    for (pid, proc_) in sys.processes() {
        let is_runtime = proc_
            .exe()
            .and_then(|e| e.file_name())
            .map(|s| s.to_string_lossy().to_lowercase())
            .map(|n| is_js_runtime(&n))
            .unwrap_or(false);
        if !is_runtime {
            continue;
        }
        if let Some(cwd) = proc_.cwd() {
            for target in &targets {
                if cwd.starts_with(target) {
                    hits.push(ProcessHit {
                        path: target.to_string_lossy().to_string(),
                        pid: pid.as_u32(),
                        name: proc_.name().to_string_lossy().to_string(),
                    });
                    break;
                }
            }
        }
    }
    hits
}

#[tauri::command]
fn check_processes(paths: Vec<String>) -> Vec<ProcessHit> {
    find_processes_in(&paths)
}

/// Reveal a path in Windows Explorer (selected in its parent folder).
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    if !PathBuf::from(&path).exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    Ok(())
}

// ---- Persistent store (ignored paths, last folder/scan, lifetime total) ----

fn store_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("store.json"))
}

fn load_store_from(path: &Path) -> Store {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn save_store_to(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn now_unix_secs() -> i64 {
    system_time_to_unix_secs(SystemTime::now())
}

#[tauri::command]
fn get_store(app: AppHandle) -> Result<Store, String> {
    Ok(load_store_from(&store_file(&app)?))
}

#[tauri::command]
fn set_ignored_paths(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let file = store_file(&app)?;
    let mut store = load_store_from(&file);
    store.ignored_paths = paths;
    save_store_to(&file, &store)
}

#[tauri::command]
fn save_scan(app: AppHandle, folder: String, projects: Vec<ProjectInfo>) -> Result<(), String> {
    let file = store_file(&app)?;
    let mut store = load_store_from(&file);
    store.last_folder = Some(folder.clone());
    store.last_scan = Some(CachedScan {
        folder,
        scanned_at: now_unix_secs(),
        projects,
    });
    save_store_to(&file, &store)
}

/// Add `bytes` to the lifetime freed total; returns the new total.
#[tauri::command]
fn record_freed(app: AppHandle, bytes: u64) -> Result<u64, String> {
    let file = store_file(&app)?;
    let mut store = load_store_from(&file);
    store.total_freed_bytes = store.total_freed_bytes.saturating_add(bytes);
    let total = store.total_freed_bytes;
    save_store_to(&file, &store)?;
    Ok(total)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            cancel_scan,
            delete_node_modules,
            delete_node_modules_batch,
            check_processes,
            reveal_in_explorer,
            get_store,
            set_ignored_paths,
            save_scan,
            record_freed
        ])
        .run(tauri::generate_context!())
        .expect("error while running safinpm");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test: last-active must reflect *modification* order and a
    /// read-only scan (metadata + directory walk) must not shift it.
    /// Previously `accessed()` was included, so merely scanning bumped every
    /// project's timestamp to scan time on systems with atime tracking on.
    #[test]
    fn last_active_follows_mtime_and_survives_a_scan() {
        let base = std::env::temp_dir().join(format!("safinpm-test-{}", generate_id()));
        let old_proj = base.join("old-proj");
        let new_proj = base.join("new-proj");
        for p in [&old_proj, &new_proj] {
            std::fs::create_dir_all(p.join("src")).unwrap();
            std::fs::write(p.join("package.json"), "{}").unwrap();
        }
        // Sleep so the two projects land in different whole seconds.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(new_proj.join("package.json"), "{\"x\":1}").unwrap();

        let old_ts = last_active_for_project(&old_proj, &old_proj.join("package.json"));
        let new_ts = last_active_for_project(&new_proj, &new_proj.join("package.json"));
        assert!(new_ts > old_ts, "newer mtime should win: {new_ts} vs {old_ts}");

        // Simulate what scan_directory does (walk + stat everything)…
        let _ = dir_size_bytes(&old_proj);
        let _ = dir_size_bytes(&new_proj);
        // …and confirm the signal didn't move.
        assert_eq!(old_ts, last_active_for_project(&old_proj, &old_proj.join("package.json")));
        assert_eq!(new_ts, last_active_for_project(&new_proj, &new_proj.join("package.json")));

        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Batch delete returns one result per path, in order; failures are
    /// reported per item and don't abort the batch. Side-effect free: only
    /// missing / wrong-name paths are used, so nothing reaches the trash.
    #[test]
    fn batch_delete_reports_per_item_results() {
        let base = std::env::temp_dir().join(format!("safinpm-test-{}", generate_id()));
        let not_node_modules = base.join("some-project");
        std::fs::create_dir_all(&not_node_modules).unwrap();

        let results = delete_node_modules_batch(vec![
            base.join("does-not-exist").join("node_modules").to_string_lossy().to_string(),
            not_node_modules.to_string_lossy().to_string(),
        ]);

        assert_eq!(results.len(), 2);
        assert!(results[0].freed_bytes.is_none());
        assert!(results[0].error.as_deref().unwrap().contains("does not exist"));
        assert!(results[1].freed_bytes.is_none());
        assert!(results[1].error.as_deref().unwrap().contains("not a node_modules folder"));

        std::fs::remove_dir_all(&base).unwrap();
    }

    fn write_manifest(dir: &Path, content: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("package.json"), content).unwrap();
    }

    #[test]
    fn detect_package_manager_prefers_field_then_lockfiles() {
        let base = std::env::temp_dir().join(format!("safinpm-test-{}", generate_id()));

        // packageManager field wins.
        let npm_proj = base.join("npm-proj");
        write_manifest(&npm_proj, r#"{"packageManager":"pnpm@9.1.0"}"#);
        let (m, est, _) = detect_package_manager(&npm_proj, load_package_manifest(&npm_proj).as_ref());
        assert_eq!(m, "pnpm");
        assert!(est, "pnpm sizes are link-based estimates");

        // Lockfile fallback.
        let yarn_proj = base.join("yarn-proj");
        write_manifest(&yarn_proj, "{}");
        std::fs::write(yarn_proj.join("yarn.lock"), "").unwrap();
        let (m, est, _) =
            detect_package_manager(&yarn_proj, load_package_manifest(&yarn_proj).as_ref());
        assert_eq!(m, "yarn");
        assert!(!est);

        // Yarn PnP marker detected.
        std::fs::write(yarn_proj.join(".pnp.cjs"), "").unwrap();
        let (_, _, pnp) =
            detect_package_manager(&yarn_proj, load_package_manifest(&yarn_proj).as_ref());
        assert!(pnp);

        // Unknown when nothing matches.
        let bare = base.join("bare");
        write_manifest(&bare, "{}");
        let (m, _, _) = detect_package_manager(&bare, load_package_manifest(&bare).as_ref());
        assert_eq!(m, "unknown");

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn workspace_roots_and_members_resolve() {
        let base = std::env::temp_dir().join(format!("safinpm-test-{}", generate_id()));
        let scan_root = base.join("tree");
        let root = scan_root.join("shop");
        let member = root.join("packages").join("web");
        let standalone = scan_root.join("blog");
        write_manifest(&root, r#"{"workspaces":["packages/*"]}"#);
        write_manifest(&member, "{}");
        write_manifest(&standalone, "{}");

        assert!(is_workspace_root(&root, load_package_manifest(&root).as_ref()));
        assert!(!is_workspace_root(&member, load_package_manifest(&member).as_ref()));

        let roots: HashSet<PathBuf> = [root.clone()].into_iter().collect();
        assert_eq!(
            find_workspace_root(&member, &roots, &scan_root),
            Some(root.clone())
        );
        assert_eq!(find_workspace_root(&standalone, &roots, &scan_root), None);
        // The root itself is not its own member.
        assert_eq!(find_workspace_root(&root, &roots, &scan_root), None);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn store_roundtrips_and_survives_corruption() {
        let file = std::env::temp_dir().join(format!("safinpm-store-{}.json", generate_id()));

        let mut store = Store::default();
        store.ignored_paths = vec!["C:\\x".to_string()];
        store.total_freed_bytes = 42;
        save_store_to(&file, &store).unwrap();
        let loaded = load_store_from(&file);
        assert_eq!(loaded.ignored_paths, vec!["C:\\x".to_string()]);
        assert_eq!(loaded.total_freed_bytes, 42);

        // Corrupt file → defaults, no panic.
        std::fs::write(&file, "{not json").unwrap();
        let fallback = load_store_from(&file);
        assert!(fallback.ignored_paths.is_empty());
        assert_eq!(fallback.total_freed_bytes, 0);

        // Missing file → defaults.
        std::fs::remove_file(&file).unwrap();
        assert_eq!(load_store_from(&file).total_freed_bytes, 0);
    }

    #[test]
    fn check_processes_ignores_empty_input() {
        assert!(find_processes_in(&[]).is_empty());
        // Bogus path matches nothing and must not error.
        assert!(find_processes_in(&["C:\\definitely-not-here-safinpm".to_string()]).is_empty());
    }

    #[test]
    fn check_processes_finds_runtime_in_cwd() {
        let dir = std::env::temp_dir().join(format!("safinpm-test-{}", generate_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut child = std::process::Command::new("node")
            .args(["-e", "setTimeout(function(){},30000)"])
            .current_dir(&dir)
            .spawn()
            .expect("node must be on PATH for this test");
        // Give sysinfo something to observe.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let hits = find_processes_in(&[dir.to_string_lossy().to_string()]);
        let found = hits.iter().any(|h| h.pid == child.id());
        child.kill().ok();
        let _ = child.wait();
        // A killed runtime can hold its cwd briefly; retry cleanup, never fail the test on it.
        for _ in 0..10 {
            if std::fs::remove_dir_all(&dir).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        assert!(found, "expected node child in {dir:?}, got {hits:?}");
    }
}
