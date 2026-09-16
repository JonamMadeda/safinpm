import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownUp,
  Boxes,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  FolderSearch,
  HardDrive,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";

interface ProjectInfo {
  id: string; // e.g. aB1cD2
  projectName: string;
  projectPath: string;
  nodeModulesPath: string | null;
  sizeBytes: number;
  sizeEstimate: boolean; // pnpm/bun: link-based, size overstates disk use
  packageManager: string; // npm | pnpm | yarn | bun | unknown
  usesPnp: boolean; // yarn PnP: no node_modules by design
  workspaceRoot: string | null; // projectPath of workspace root, if member
  isWorkspaceRoot: boolean;
  lastActiveTimestamp: number; // unix seconds
}

interface BatchDeleteResult {
  path: string;
  freedBytes: number | null;
  error: string | null;
}

interface ScanProgress {
  phase: string; // "walk" | "measure"
  done: number;
  total: number;
}

interface ProcessHit {
  path: string;
  pid: number;
  name: string;
}

interface CachedScan {
  folder: string;
  scannedAt: number;
  projects: ProjectInfo[];
}

interface StoreData {
  ignoredPaths: string[];
  lastFolder: string | null;
  lastScan: CachedScan | null;
  totalFreedBytes: number;
}

type SortKey = "lastActiveTimestamp" | "sizeBytes" | "projectName";
type Chip = "all" | "cleanable" | "cleaned" | "stale" | "workspace";

function isStale(ts: number): boolean {
  return ts > 0 && Date.now() - ts * 1000 > 90 * 86400000;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function timeAgo(unixSecs: number): string {
  if (!unixSecs) return "unknown";
  const diffMs = Date.now() - unixSecs * 1000;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days > 1 ? "s" : ""} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? "s" : ""} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

function statusFor(ts: number): { label: string; cls: string } {
  if (!ts) return { label: "Unknown", cls: "bg-slate-700 text-slate-300" };
  const days = (Date.now() - ts * 1000) / 86400000;
  if (days > 180)
    return { label: "Inactive > 6 months", cls: "bg-red-500/15 text-red-400 border-red-500/30" };
  if (days > 90)
    return { label: "Stale > 3 months", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  return { label: "Active", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
}

export default function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [folder, setFolder] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("lastActiveTimestamp");
  const [sortAsc, setSortAsc] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [pendingBulk, setPendingBulk] = useState<ProjectInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string>("");
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [showIgnored, setShowIgnored] = useState(false);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  const [lastFolder, setLastFolder] = useState<string>("");
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [cacheBanner, setCacheBanner] = useState(false);
  const [totalFreed, setTotalFreed] = useState(0);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [inUse, setInUse] = useState<ProcessHit[]>([]);
  const cancelRequested = useRef(false);

  const sorted = useMemo(() => {
    const arr = [...projects];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "projectName") cmp = a.projectName.localeCompare(b.projectName);
      else if (sortKey === "sizeBytes") cmp = a.sizeBytes - b.sizeBytes;
      else cmp = a.lastActiveTimestamp - b.lastActiveTimestamp;
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [projects, sortKey, sortAsc]);

  const totalReclaimable = useMemo(
    () => projects.reduce((s, p) => s + (p.sizeBytes || 0), 0),
    [projects]
  );

  // Visible rows: ignored projects are hidden unless the ignored panel is open,
  // then chip + search filters apply.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((p) => {
      if (ignored.has(p.projectPath)) return false;
      if (chip === "cleanable" && !p.nodeModulesPath) return false;
      if (chip === "cleaned" && p.nodeModulesPath) return false;
      if (chip === "stale" && !isStale(p.lastActiveTimestamp)) return false;
      if (chip === "workspace" && !p.workspaceRoot && !p.isWorkspaceRoot) return false;
      if (q && !p.projectName.toLowerCase().includes(q) && !p.projectPath.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [sorted, ignored, chip, query]);

  const ignoredProjects = useMemo(
    () => sorted.filter((p) => ignored.has(p.projectPath)),
    [sorted, ignored]
  );

  const unignored = useMemo(() => sorted.filter((p) => !ignored.has(p.projectPath)), [sorted, ignored]);

  const chipCounts = useMemo(() => {
    return {
      all: unignored.length,
      cleanable: unignored.filter((p) => p.nodeModulesPath).length,
      cleaned: unignored.filter((p) => !p.nodeModulesPath).length,
      stale: unignored.filter((p) => isStale(p.lastActiveTimestamp)).length,
      workspace: unignored.filter((p) => p.workspaceRoot || p.isWorkspaceRoot).length,
    };
  }, [unignored]);

  const nameByPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.projectPath, p.projectName);
    return m;
  }, [projects]);

  // Only rows that still have a node_modules folder are selectable.
  const cleanableVisible = useMemo(() => visible.filter((p) => p.nodeModulesPath), [visible]);
  const selectedProjects = useMemo(
    () => projects.filter((p) => selected.has(p.id) && p.nodeModulesPath && !ignored.has(p.projectPath)),
    [projects, selected, ignored]
  );
  const selectedBytes = useMemo(
    () => selectedProjects.reduce((s, p) => s + (p.sizeBytes || 0), 0),
    [selectedProjects]
  );
  const allSelected = cleanableVisible.length > 0 && cleanableVisible.every((p) => selected.has(p.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(cleanableVisible.map((p) => p.id)));
  }

  // ---- Effects: live scan events + persisted store ----
  useEffect(() => {
    let unProgress: (() => void) | undefined;
    let unProject: (() => void) | undefined;
    (async () => {
      unProgress = await listen<ScanProgress>("safinpm-scan-progress", (e) =>
        setScanProgress(e.payload)
      );
      unProject = await listen<ProjectInfo>("safinpm-scan-project", (e) => {
        setProjects((prev) =>
          prev.some((p) => p.id === e.payload.id) ? prev : [...prev, e.payload]
        );
      });
    })();
    (async () => {
      try {
        const s = await invoke<StoreData>("get_store");
        setIgnored(new Set(s.ignoredPaths || []));
        setTotalFreed(s.totalFreedBytes || 0);
        if (s.lastFolder) setLastFolder(s.lastFolder);
        if (s.lastScan) {
          setProjects(s.lastScan.projects);
          setFolder(s.lastScan.folder);
          setCachedAt(s.lastScan.scannedAt);
          setCacheBanner(true);
        }
      } catch {
        // First run: no store yet.
      }
    })();
    return () => {
      unProgress?.();
      unProject?.();
    };
  }, []);

  // In-use check whenever a confirm dialog opens.
  const modalTargets = pendingBulk
    ? pendingBulk.map((p) => p.projectPath)
    : pendingDelete
      ? [pendingDelete.projectPath]
      : [];
  useEffect(() => {
    if (modalTargets.length === 0) {
      setInUse([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const hits = await invoke<ProcessHit[]>("check_processes", { paths: modalTargets });
        if (alive) setInUse(hits);
      } catch {
        if (alive) setInUse([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelete, pendingBulk]);

  // Esc closes any confirm dialog.
  useEffect(() => {
    if (!pendingDelete && !pendingBulk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPendingDelete(null);
        setPendingBulk(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDelete, pendingBulk]);

  function closeModal() {
    setPendingDelete(null);
    setPendingBulk(null);
  }

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3500);
  }

  async function handleSelectFolder() {
    setError("");
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select Projects folder" });
      if (typeof selected !== "string" || !selected) return;
      setFolder(selected);
      await runScan(selected);
    } catch (e) {
      setError(`Could not open folder picker: ${String(e)}`);
    }
  }

  async function runScan(dir: string) {
    const previous = projects; // restore if the rescan fails
    setScanning(true);
    setError("");
    setCacheBanner(false);
    setCachedAt(null);
    setScanProgress(null);
    setProjects([]);
    setSelected(new Set()); // ids are regenerated per scan
    cancelRequested.current = false;
    try {
      // Rows stream in live via safinpm-scan-project events; the return value
      // is the final sorted list (or a partial list if cancelled).
      const result = await invoke<ProjectInfo[]>("scan_directory", { path: dir });
      setProjects(result);
      if (cancelRequested.current) {
        showToast(`Scan cancelled — showing partial results (${result.length})`);
      } else {
        if (result.length === 0) showToast("No Node.js projects found");
        try {
          await invoke("save_scan", { folder: dir, projects: result });
        } catch {
          // Cache is best-effort.
        }
      }
    } catch (e) {
      setProjects(previous);
      setError(`Scan failed: ${String(e)}`);
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  async function cancelScan() {
    cancelRequested.current = true;
    try {
      await invoke("cancel_scan");
    } catch (e) {
      setError(`Could not cancel scan: ${String(e)}`);
    }
  }

  async function persistIgnored(next: Set<string>) {
    setIgnored(next);
    try {
      await invoke("set_ignored_paths", { paths: [...next] });
    } catch (e) {
      setError(`Could not save ignore list: ${String(e)}`);
    }
  }

  function ignoreProject(p: ProjectInfo) {
    const next = new Set(ignored);
    next.add(p.projectPath);
    setSelected((prev) => {
      const s = new Set(prev);
      s.delete(p.id);
      return s;
    });
    void persistIgnored(next);
  }

  function unignoreProject(path: string) {
    const next = new Set(ignored);
    next.delete(path);
    void persistIgnored(next);
  }

  async function reveal(path: string) {
    try {
      await invoke("reveal_in_explorer", { path });
    } catch (e) {
      setError(`Could not open Explorer: ${String(e)}`);
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      showToast("Path copied");
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  async function addFreed(bytes: number) {
    if (!bytes) return;
    try {
      const total = await invoke<number>("record_freed", { bytes });
      setTotalFreed(total);
    } catch {
      // Lifetime total is best-effort.
    }
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === "lastActiveTimestamp" ? true : false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete?.nodeModulesPath) return;
    setDeleting(true);
    try {
      const freed = await invoke<number>("delete_node_modules", {
        path: pendingDelete.nodeModulesPath,
      });
      setProjects((prev) =>
        prev.map((p) =>
          p.id === pendingDelete.id ? { ...p, nodeModulesPath: null, sizeBytes: 0 } : p
        )
      );
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(pendingDelete.id);
        return next;
      });
      showToast(`Freed ${formatBytes(freed)} from ${pendingDelete.projectName}`);
      void addFreed(freed);
    } catch (e) {
      setError(`Delete failed: ${String(e)}`);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  async function confirmBulkDelete() {
    if (!pendingBulk || pendingBulk.length === 0) return;
    setDeleting(true);
    try {
      const paths = pendingBulk.map((p) => p.nodeModulesPath as string);
      const results = await invoke<BatchDeleteResult[]>("delete_node_modules_batch", { paths });
      const okPaths = new Set(
        results.filter((r) => r.freedBytes != null).map((r) => r.path)
      );
      const failures = results.filter((r) => r.error != null);
      const freedTotal = results.reduce((s, r) => s + (r.freedBytes || 0), 0);
      const okIds = new Set(
        pendingBulk.filter((p) => p.nodeModulesPath && okPaths.has(p.nodeModulesPath)).map((p) => p.id)
      );
      setProjects((prev) =>
        prev.map((p) =>
          okIds.has(p.id) ? { ...p, nodeModulesPath: null, sizeBytes: 0 } : p
        )
      );
      setSelected(new Set());
      void addFreed(freedTotal);
      if (failures.length === 0) {
        showToast(`Freed ${formatBytes(freedTotal)} across ${okIds.size} projects`);
      } else {
        setError(
          `Cleaned ${okIds.size} of ${pendingBulk.length}; ${failures.length} failed — first error: ${failures[0].error}`
        );
        if (okIds.size > 0) showToast(`Freed ${formatBytes(freedTotal)} across ${okIds.size} projects`);
      }
    } catch (e) {
      setError(`Bulk delete failed: ${String(e)}`);
    } finally {
      setDeleting(false);
      setPendingBulk(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
          <div className="flex items-center gap-2">
            <HardDrive className="h-6 w-6 text-cyan-400" />
            <h1 className="text-xl font-bold tracking-tight">
              safi<span className="text-cyan-400">npm</span>
            </h1>
          </div>
          <p className="hidden text-sm text-slate-400 md:block">
            Find stale node_modules &amp; reclaim disk space
          </p>
          <div className="ml-auto flex items-center gap-2">
            {folder && (
              <button
                onClick={() => runScan(folder)}
                disabled={scanning}
                className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:border-slate-600 disabled:opacity-50"
              >
                {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Rescan
              </button>
            )}
            <button
              onClick={handleSelectFolder}
              disabled={scanning}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              <FolderOpen className="h-4 w-4" />
              {folder ? "Change Folder" : "Select Folder"}
            </button>
          </div>
        </div>
        {folder ? (
          <div className="mx-auto max-w-6xl truncate px-6 pb-3 text-xs text-slate-400">
            Scanning: <span className="text-slate-200">{folder}</span>
          </div>
        ) : lastFolder ? (
          <div className="mx-auto max-w-6xl truncate px-6 pb-3 text-xs text-slate-400">
            Last folder:{" "}
            <button
              onClick={() => {
                setFolder(lastFolder);
                void runScan(lastFolder);
              }}
              className="text-cyan-400 hover:underline"
            >
              {lastFolder} (rescan)
            </button>
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-6 py-6">
        {error && (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {cacheBanner && cachedAt && !scanning && projects.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-200">
            <History className="h-4 w-4 shrink-0" />
            <span>
              Showing cached results from {new Date(cachedAt * 1000).toLocaleString()}.
            </span>
            <button
              onClick={() => folder && runScan(folder)}
              className="rounded-lg bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-500"
            >
              Rescan now
            </button>
            <button
              onClick={() => setCacheBanner(false)}
              aria-label="Dismiss cached notice"
              className="ml-auto text-cyan-300 hover:text-cyan-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">Projects found</div>
            <div className="mt-1 text-2xl font-bold">{projects.length}</div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">Reclaimable space</div>
            <div className="mt-1 text-2xl font-bold text-cyan-400">{formatBytes(totalReclaimable)}</div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">With node_modules</div>
            <div className="mt-1 text-2xl font-bold">
              {projects.filter((p) => p.nodeModulesPath).length}
            </div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">Freed all-time</div>
            <div className="mt-1 text-2xl font-bold text-emerald-400">{formatBytes(totalFreed)}</div>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
          <div className="space-y-2 border-b border-slate-700 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
              <ArrowDownUp className="h-4 w-4 shrink-0" />
              <span className="hidden lg:inline">Ranked oldest-first by last activity.</span>
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or path…"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 py-1.5 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
                />
              </div>
              {ignoredProjects.length > 0 && (
                <button
                  onClick={() => setShowIgnored((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Ignored ({ignoredProjects.length})
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["cleanable", "Cleanable"],
                  ["cleaned", "Cleaned"],
                  ["stale", "Stale >3mo"],
                  ["workspace", "In workspace"],
                ] as [Chip, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setChip(id)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    chip === id
                      ? "border-cyan-500 bg-cyan-500/15 text-cyan-300"
                      : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  }`}
                >
                  {label} ({chipCounts[id]})
                </button>
              ))}
            </div>
            {selectedProjects.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-cyan-500/10 px-3 py-2">
                <span className="text-xs text-slate-200">
                  {selectedProjects.length} selected • {formatBytes(selectedBytes)}
                </span>
                <button
                  onClick={() => setPendingBulk(selectedProjects)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clean selected
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {scanning && (
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-400" />
              <span>
                {scanProgress
                  ? scanProgress.phase === "walk"
                    ? `Finding projects… (${scanProgress.done} dirs visited)`
                    : `Measuring node_modules… ${scanProgress.done}/${scanProgress.total || "?"}`
                  : "Scanning disk in parallel…"}
              </span>
              {scanProgress && scanProgress.phase === "measure" && scanProgress.total > 0 && (
                <div className="h-2 w-48 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-cyan-500 transition-all"
                    style={{ width: `${(scanProgress.done / scanProgress.total) * 100}%` }}
                  />
                </div>
              )}
              <button
                onClick={cancelScan}
                className="ml-auto rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:border-red-500/60 hover:text-red-400"
              >
                Cancel scan
              </button>
            </div>
          )}

          {projects.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
              {scanning ? (
                <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
              ) : (
                <FolderOpen className="h-10 w-10 text-slate-600" />
              )}
              <p className="text-sm text-slate-400">
                {scanning ? (
                  "Scanning… rows will appear here as projects are found."
                ) : (
                  <>
                    Select a folder (e.g. your Projects directory) to scan for{" "}
                    <code className="text-slate-200">package.json</code> projects.
                  </>
                )}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
              <Search className="h-10 w-10 text-slate-600" />
              <p className="text-sm text-slate-400">
                No projects match the current search / filters.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wide text-slate-400">
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = selectedProjects.length > 0 && !allSelected;
                        }}
                        onChange={toggleAll}
                        aria-label="Select all"
                        className="h-4 w-4 accent-cyan-500"
                      />
                    </th>
                    <th className="px-4 py-3">
                      <button onClick={() => toggleSort("projectName")} className="hover:text-slate-200">
                        Project {sortKey === "projectName" ? (sortAsc ? "↑" : "↓") : ""}
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button onClick={() => toggleSort("lastActiveTimestamp")} className="hover:text-slate-200">
                        Last active {sortKey === "lastActiveTimestamp" ? (sortAsc ? "↑" : "↓") : ""}
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button onClick={() => toggleSort("sizeBytes")} className="hover:text-slate-200">
                        Size {sortKey === "sizeBytes" ? (sortAsc ? "↑" : "↓") : ""}
                      </button>
                    </th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => {
                    const status = statusFor(p.lastActiveTimestamp);
                    const isSelected = selected.has(p.id);
                    const wsName = p.workspaceRoot ? nameByPath.get(p.workspaceRoot) : null;
                    return (
                      <tr
                        key={p.id}
                        className={`border-b border-slate-700/60 last:border-0 hover:bg-slate-700/30 ${
                          isSelected ? "bg-cyan-500/10" : ""
                        }`}
                      >
                        <td className="px-4 py-3">
                          {p.nodeModulesPath ? (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleOne(p.id)}
                              aria-label={`Select ${p.projectName}`}
                              className="h-4 w-4 accent-cyan-500"
                            />
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-slate-100">{p.projectName}</span>
                            {p.packageManager !== "unknown" && (
                              <span
                                title={`Package manager: ${p.packageManager}`}
                                className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300"
                              >
                                {p.packageManager}
                              </span>
                            )}
                            {p.isWorkspaceRoot && (
                              <span
                                title="Workspace root"
                                className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300"
                              >
                                <Boxes className="h-3 w-3" />
                                root
                              </span>
                            )}
                            {!p.isWorkspaceRoot && p.workspaceRoot && (
                              <span
                                title={`Workspace member of ${p.workspaceRoot}`}
                                className="inline-flex max-w-[180px] items-center gap-1 truncate rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400"
                              >
                                <Boxes className="h-3 w-3 shrink-0" />
                                {wsName || "workspace"}
                              </span>
                            )}
                          </div>
                          <div className="max-w-[380px] truncate text-xs text-slate-400" title={p.projectPath}>
                            {p.projectPath}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                          <div className="flex items-center gap-1.5">
                            <Clock className="h-3.5 w-3.5 text-slate-500" />
                            {timeAgo(p.lastActiveTimestamp)}
                          </div>
                          <div className="text-xs text-slate-500">
                            {p.lastActiveTimestamp
                              ? new Date(p.lastActiveTimestamp * 1000).toLocaleDateString()
                              : "—"}
                          </div>
                        </td>
                        <td
                          className="whitespace-nowrap px-4 py-3 font-semibold text-slate-100"
                          title={
                            p.sizeEstimate
                              ? "Link-based install (pnpm/bun): node_modules points into a shared store, real disk use may be lower"
                              : undefined
                          }
                        >
                          {p.sizeBytes ? (p.sizeEstimate ? `~${formatBytes(p.sizeBytes)}` : formatBytes(p.sizeBytes)) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${status.cls}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => reveal(p.projectPath)}
                              title="Reveal in Explorer"
                              className="rounded-lg border border-transparent p-1.5 text-slate-400 hover:border-slate-700 hover:text-slate-100"
                            >
                              <FolderSearch className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => copyPath(p.projectPath)}
                              title="Copy path"
                              className="rounded-lg border border-transparent p-1.5 text-slate-400 hover:border-slate-700 hover:text-slate-100"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => ignoreProject(p)}
                              title="Ignore this project (hide from scans)"
                              className="rounded-lg border border-transparent p-1.5 text-slate-400 hover:border-slate-700 hover:text-slate-100"
                            >
                              <EyeOff className="h-4 w-4" />
                            </button>
                            {p.nodeModulesPath ? (
                              <button
                                onClick={() => setPendingDelete(p)}
                                title={`Move node_modules to Recycle Bin (${formatBytes(p.sizeBytes)})`}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-red-500/50 hover:text-red-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Clean
                              </button>
                            ) : p.usesPnp ? (
                              <span title="Yarn PnP: dependencies are zipped, there is no node_modules to clean" className="text-xs text-slate-500">
                                PnP
                              </span>
                            ) : (
                              <span className="text-xs text-slate-500">cleaned</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {showIgnored && ignoredProjects.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
            <div className="border-b border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200">
              Ignored projects ({ignoredProjects.length}) — hidden from scans
            </div>
            <ul className="divide-y divide-slate-700/60">
              {ignoredProjects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <EyeOff className="h-4 w-4 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-200">{p.projectName}</div>
                    <div className="truncate text-xs text-slate-500" title={p.projectPath}>
                      {p.projectPath}
                    </div>
                  </div>
                  <button
                    onClick={() => unignoreProject(p.projectPath)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Unignore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-slate-500">
          Safety: deletion moves <code>node_modules</code> to the Windows Recycle Bin via the Rust{" "}
          <code>trash</code> crate — nothing is permanently deleted. Reinstall anytime with{" "}
          <code>npm install</code>.
        </p>
      </main>

      {/* Confirm dialog (single + bulk) */}
      {(pendingDelete || pendingBulk) && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold">Move to Recycle Bin?</h2>
            {inUse.length > 0 && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  A JS runtime looks active here — close dev servers / installs first:{" "}
                  {inUse.map((h) => `${h.name} (pid ${h.pid})`).join(", ")}
                </span>
              </div>
            )}
            {pendingBulk && pendingBulk.some((p) => !isStale(p.lastActiveTimestamp)) && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {pendingBulk.filter((p) => !isStale(p.lastActiveTimestamp)).length} of{" "}
                  {pendingBulk.length} selected look <strong>Active</strong> (touched in the last
                  3 months). Cleaning them may interrupt current work.
                </span>
              </div>
            )}
            {pendingDelete && (
              <>
                <p className="mt-2 text-sm text-slate-400">
                  <span className="font-semibold text-slate-100">{pendingDelete.projectName}</span> —{" "}
                  {formatBytes(pendingDelete.sizeBytes)} will be moved to the Recycle Bin:
                </p>
                <p className="mt-2 break-all rounded-lg bg-slate-900 p-2 font-mono text-xs text-slate-300">
                  {pendingDelete.nodeModulesPath}
                </p>
              </>
            )}
            {pendingBulk && (
              <>
                <p className="mt-2 text-sm text-slate-400">
                  <span className="font-semibold text-slate-100">
                    {pendingBulk.length} projects
                  </span>{" "}
                  — {formatBytes(pendingBulk.reduce((s, p) => s + (p.sizeBytes || 0), 0))} total
                  will be moved to the Recycle Bin:
                </p>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-slate-900 p-2 font-mono text-xs text-slate-300">
                  {pendingBulk.map((p) => (
                    <li key={p.id} className="truncate" title={p.nodeModulesPath || ""}>
                      {p.projectName} <span className="text-slate-500">({formatBytes(p.sizeBytes)})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeModal}
                disabled={deleting}
                autoFocus
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={pendingBulk ? confirmBulkDelete : confirmDelete}
                disabled={deleting}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                {pendingBulk ? `Yes, recycle ${pendingBulk.length}` : "Yes, recycle it"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-slate-800 px-4 py-3 text-sm shadow-2xl">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
