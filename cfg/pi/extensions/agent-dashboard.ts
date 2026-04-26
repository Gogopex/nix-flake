import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type DashboardOverlayMode = "normal" | "wide" | "full";

type DashboardConfig = {
  enabled: boolean;
  refreshMs: number;
  staleAfterMs: number;
  recentSessionCount: number;
  overlayMode: DashboardOverlayMode;
};

type VcsEngine = "jj" | "git" | "none";
type ActivityStatus = "idle" | "running" | "stale";
type DashboardTab = "active" | "sessions";
type FilterMode = "active" | "repo" | "all";

type RepoSnapshot = {
  root?: string;
  engine: VcsEngine;
  workspace?: string;
  changeId?: string;
  branch?: string;
  head?: string;
};

type ActivityMarker = {
  version: 1;
  kind: "session";
  pid: number;
  sessionFile?: string;
  sessionId?: string;
  cwd: string;
  repoRoot?: string;
  vcsEngine: VcsEngine;
  workspace?: string;
  changeId?: string;
  branch?: string;
  head?: string;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  sessionName?: string;
  profile?: string;
  authMode?: "sub" | "api" | "unknown";
  taskSummary?: string;
  phase?: string;
  lastTool?: string;
  startedAt: number;
  lastUpdate: number;
  status: ActivityStatus;
};

type IsoMarker = {
  id: string;
  pid: number;
  startedAt: number;
  worktree: string;
  task: string;
  stale: boolean;
};

type SessionInfoLike = Awaited<ReturnType<typeof SessionManager.listAll>>[number];

type ActiveSessionItem = {
  kind: "active-session";
  id: string;
  marker: ActivityMarker;
  session?: SessionInfoLike;
};

type ActiveIsoItem = {
  kind: "active-iso";
  id: string;
  marker: IsoMarker;
  repoRoot?: string;
};

type SessionItem = {
  kind: "session";
  id: string;
  session: SessionInfoLike;
  marker?: ActivityMarker;
};

type DashboardItem = ActiveSessionItem | ActiveIsoItem | SessionItem;

type DashboardResult =
  | { action: "switch-session"; sessionPath: string }
  | { action: "noop" }
  | null;

const DEFAULT_CONFIG: DashboardConfig = {
  enabled: false,
  refreshMs: 2500,
  staleAfterMs: 3 * 60_000,
  recentSessionCount: 60,
  overlayMode: "normal",
};

const repoCache = new Map<string, { at: number; value: RepoSnapshot }>();
const sessionListCache = {
  at: 0,
  value: [] as SessionInfoLike[],
};

let currentMarkerPath: string | undefined;
let currentMarker: ActivityMarker | undefined;

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getActivityDir(): string {
  return path.join(getAgentDir(), "activity");
}

function getIsoDir(): string {
  return path.join(getAgentDir(), "wt");
}

function getIsoActiveDir(): string {
  return path.join(getIsoDir(), "active");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function loadConfig(cwd: string): DashboardConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = global.agentDashboard && typeof global.agentDashboard === "object"
    ? (global.agentDashboard as Record<string, unknown>)
    : {};
  const p = project.agentDashboard && typeof project.agentDashboard === "object"
    ? (project.agentDashboard as Record<string, unknown>)
    : {};

  const enabled = typeof p.enabled === "boolean" ? p.enabled : typeof g.enabled === "boolean" ? g.enabled : DEFAULT_CONFIG.enabled;
  const refreshMsRaw = typeof p.refreshMs === "number" ? p.refreshMs : typeof g.refreshMs === "number" ? g.refreshMs : DEFAULT_CONFIG.refreshMs;
  const staleAfterMsRaw = typeof p.staleAfterMs === "number" ? p.staleAfterMs : typeof g.staleAfterMs === "number" ? g.staleAfterMs : DEFAULT_CONFIG.staleAfterMs;
  const recentSessionCountRaw = typeof p.recentSessionCount === "number"
    ? p.recentSessionCount
    : typeof g.recentSessionCount === "number"
      ? g.recentSessionCount
      : DEFAULT_CONFIG.recentSessionCount;
  const overlayModeRaw = typeof p.overlayMode === "string"
    ? p.overlayMode
    : typeof g.overlayMode === "string"
      ? g.overlayMode
      : DEFAULT_CONFIG.overlayMode;
  const overlayMode: DashboardOverlayMode = overlayModeRaw === "wide" || overlayModeRaw === "full" ? overlayModeRaw : "normal";

  return {
    enabled,
    refreshMs: Math.max(1000, Math.min(30_000, Math.floor(refreshMsRaw))),
    staleAfterMs: Math.max(30_000, Math.min(24 * 60 * 60_000, Math.floor(staleAfterMsRaw))),
    recentSessionCount: Math.max(10, Math.min(400, Math.floor(recentSessionCountRaw))),
    overlayMode,
  };
}

function writeGlobalConfig(partial: Partial<DashboardConfig>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJson(settingsPath);
  const existing = current.agentDashboard && typeof current.agentDashboard === "object"
    ? (current.agentDashboard as Record<string, unknown>)
    : {};
  current.agentDashboard = { ...existing, ...partial };
  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function compactOneLine(input: string | undefined, maxLength: number): string {
  const text = (input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactPath(cwd: string): string {
  const home = os.homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function basenameSafe(value: string | undefined): string {
  if (!value) return "-";
  const base = path.basename(value);
  return base || value;
}

function hashKey(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 32);
}

function processExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStatusProfile(cwd: string): string | undefined {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));
  const pick = (raw: Record<string, unknown>): string | undefined => {
    const block = raw.statusBarV2;
    if (!block || typeof block !== "object") return undefined;
    const value = (block as Record<string, unknown>).profile;
    return typeof value === "string" ? value : undefined;
  };
  return pick(project) ?? pick(global);
}

function getAuthMode(ctx: any): "sub" | "api" | "unknown" {
  if (!ctx.model || typeof ctx.modelRegistry?.isUsingOAuth !== "function") return "unknown";
  return ctx.modelRegistry.isUsingOAuth(ctx.model) ? "sub" : "api";
}

function getSessionFile(ctx: any): string | undefined {
  return typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
}

function getSessionId(ctx: any): string | undefined {
  if (typeof ctx.sessionManager?.getSessionId === "function") return ctx.sessionManager.getSessionId();
  const header = typeof ctx.sessionManager?.getHeader === "function" ? ctx.sessionManager.getHeader() : undefined;
  return typeof header?.id === "string" ? header.id : undefined;
}

function getSessionName(ctx: any, pi: ExtensionAPI): string | undefined {
  if (typeof pi.getSessionName === "function") return pi.getSessionName();
  if (typeof ctx.sessionManager?.getSessionName === "function") return ctx.sessionManager.getSessionName();
  return undefined;
}

function parseJjWorkspaceList(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.includes("*")) {
      const cleaned = line.replace("*", "").trim();
      return cleaned.includes(":") ? cleaned.split(":")[0]?.trim() : cleaned.split(/\s+/)[0]?.trim();
    }
  }
  const first = lines[0];
  if (!first) return undefined;
  return first.includes(":") ? first.split(":")[0]?.trim() : first.split(/\s+/)[0]?.trim();
}

async function exec(pi: ExtensionAPI, cwd: string, command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await pi.exec(command, args, { cwd, timeout: 4000 });
  return {
    code: typeof result.code === "number" ? result.code : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

async function getRepoSnapshot(pi: ExtensionAPI, cwd: string): Promise<RepoSnapshot> {
  const cached = repoCache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < 4000) return cached.value;

  const jjRoot = await exec(pi, cwd, "jj", ["root"]);
  if (jjRoot.code === 0) {
    const root = jjRoot.stdout.trim();
    const wsRes = await exec(pi, root, "jj", ["workspace", "list", "--color", "never"]);
    const changeRes = await exec(pi, root, "jj", ["log", "-r", "@", "-T", "change_id.short()", "--no-graph", "--color", "never"]);
    const value: RepoSnapshot = {
      root,
      engine: "jj",
      workspace: parseJjWorkspaceList(wsRes.stdout),
      changeId: changeRes.stdout.trim().split(/\s+/)[0] || undefined,
    };
    repoCache.set(cwd, { at: now, value });
    return value;
  }

  const gitRoot = await exec(pi, cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (gitRoot.code === 0) {
    const root = gitRoot.stdout.trim();
    const branchRes = await exec(pi, root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const headRes = await exec(pi, root, "git", ["rev-parse", "--short", "HEAD"]);
    const value: RepoSnapshot = {
      root,
      engine: "git",
      branch: branchRes.stdout.trim() || undefined,
      head: headRes.stdout.trim() || undefined,
    };
    repoCache.set(cwd, { at: now, value });
    return value;
  }

  const value: RepoSnapshot = { engine: "none" };
  repoCache.set(cwd, { at: now, value });
  return value;
}

function markerFilePath(sessionFile: string | undefined, sessionId: string | undefined, pid: number): string {
  const key = sessionFile || sessionId || `cwd:${process.cwd()}`;
  return path.join(getActivityDir(), `session-${pid}-${hashKey(key)}.json`);
}

function removeCurrentMarker(): void {
  if (currentMarkerPath && fs.existsSync(currentMarkerPath)) {
    try {
      fs.unlinkSync(currentMarkerPath);
    } catch {
      // ignore cleanup failures
    }
  }
  currentMarkerPath = undefined;
  currentMarker = undefined;
}

async function updateActivityMarker(pi: ExtensionAPI, ctx: any, partial: Partial<ActivityMarker>): Promise<void> {
  const cfg = loadConfig(ctx.cwd);
  if (!cfg.enabled) {
    removeCurrentMarker();
    return;
  }

  ensureDir(getActivityDir());

  const sessionFile = getSessionFile(ctx);
  const sessionId = getSessionId(ctx);
  const nextPath = markerFilePath(sessionFile, sessionId, process.pid);
  if (currentMarkerPath && currentMarkerPath !== nextPath) {
    removeCurrentMarker();
  }

  const repo = await getRepoSnapshot(pi, ctx.cwd);
  const now = Date.now();
  const base: ActivityMarker = {
    version: 1,
    kind: "session",
    pid: process.pid,
    sessionFile,
    sessionId,
    cwd: ctx.cwd,
    repoRoot: repo.root,
    vcsEngine: repo.engine,
    workspace: repo.workspace,
    changeId: repo.changeId,
    branch: repo.branch,
    head: repo.head,
    modelId: ctx.model?.id,
    provider: ctx.model?.provider,
    thinkingLevel: typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined,
    sessionName: getSessionName(ctx, pi),
    profile: readStatusProfile(ctx.cwd),
    authMode: getAuthMode(ctx),
    taskSummary: currentMarker?.taskSummary,
    phase: currentMarker?.phase,
    lastTool: currentMarker?.lastTool,
    startedAt: currentMarker?.startedAt ?? now,
    lastUpdate: now,
    status: currentMarker?.status ?? "idle",
  };

  const next: ActivityMarker = {
    ...base,
    ...currentMarker,
    ...partial,
    sessionFile,
    sessionId,
    cwd: ctx.cwd,
    repoRoot: repo.root,
    vcsEngine: repo.engine,
    workspace: repo.workspace,
    changeId: repo.changeId,
    branch: repo.branch,
    head: repo.head,
    modelId: ctx.model?.id,
    provider: ctx.model?.provider,
    thinkingLevel: typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined,
    sessionName: getSessionName(ctx, pi),
    profile: readStatusProfile(ctx.cwd),
    authMode: getAuthMode(ctx),
    lastUpdate: now,
    startedAt: currentMarker?.startedAt ?? now,
  };

  fs.writeFileSync(nextPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  currentMarkerPath = nextPath;
  currentMarker = next;
}

function readActivityMarkers(staleAfterMs: number): ActivityMarker[] {
  const dir = getActivityDir();
  if (!fs.existsSync(dir)) return [];

  const now = Date.now();
  const markers: ActivityMarker[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    try {
      const marker = JSON.parse(fs.readFileSync(full, "utf8")) as ActivityMarker;
      const dead = !processExists(marker.pid);
      const stale = dead || now - marker.lastUpdate > staleAfterMs;
      markers.push({
        ...marker,
        status: stale ? "stale" : marker.status,
      });
    } catch {
      // ignore malformed marker files
    }
  }
  return markers;
}

function readIsoMarkers(): IsoMarker[] {
  const dir = getIsoActiveDir();
  if (!fs.existsSync(dir)) return [];

  const markers: IsoMarker[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
      const pid = Number(raw.pid || 0);
      const worktree = String(raw.worktree || "");
      const stale = !worktree || !fs.existsSync(worktree) || !processExists(pid);
      markers.push({
        id: String(raw.id || entry.replace(/\.json$/, "")),
        pid,
        startedAt: Number(raw.startedAt || 0),
        worktree,
        task: String(raw.task || ""),
        stale,
      });
    } catch {
      // ignore malformed markers
    }
  }
  return markers;
}

async function getAllSessionsCached(): Promise<SessionInfoLike[]> {
  const now = Date.now();
  if (now - sessionListCache.at < 4000 && sessionListCache.value.length > 0) return sessionListCache.value;
  const value = await SessionManager.listAll();
  sessionListCache.at = now;
  sessionListCache.value = value;
  return value;
}

async function getDashboardData(pi: ExtensionAPI, ctx: any, cfg: DashboardConfig): Promise<{
  currentRepo?: string;
  activeItems: DashboardItem[];
  sessionItems: DashboardItem[];
}> {
  const currentRepo = (await getRepoSnapshot(pi, ctx.cwd)).root;
  const [markers, sessions] = await Promise.all([
    Promise.resolve(readActivityMarkers(cfg.staleAfterMs)),
    getAllSessionsCached(),
  ]);
  const isoMarkers = readIsoMarkers();

  const sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
  const markersBySessionPath = new Map<string, ActivityMarker>();
  for (const marker of markers) {
    if (marker.sessionFile) markersBySessionPath.set(marker.sessionFile, marker);
  }

  const activeSessionItems: DashboardItem[] = markers
    .slice()
    .sort((a, b) => b.lastUpdate - a.lastUpdate)
    .map((marker) => ({
      kind: "active-session",
      id: `marker:${marker.pid}:${marker.sessionFile || marker.cwd}`,
      marker,
      session: marker.sessionFile ? sessionsByPath.get(marker.sessionFile) : undefined,
    }));

  const activeIsoItems: DashboardItem[] = isoMarkers
    .slice()
    .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))
    .map((marker) => ({
      kind: "active-iso",
      id: `iso:${marker.id}`,
      marker,
      repoRoot: marker.worktree || undefined,
    }));

  const sessionItems: DashboardItem[] = sessions
    .slice()
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, cfg.recentSessionCount)
    .map((session) => ({
      kind: "session",
      id: `session:${session.path}`,
      session,
      marker: markersBySessionPath.get(session.path),
    }));

  return {
    currentRepo,
    activeItems: [...activeSessionItems, ...activeIsoItems],
    sessionItems,
  };
}

function timeAgo(ts: number | Date | undefined): string {
  const value = ts instanceof Date ? ts.getTime() : ts;
  if (!value || !Number.isFinite(value)) return "?";
  const delta = Math.max(0, Date.now() - value);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function formatThinkingMeter(level: string | undefined, theme: any): string {
  const empty = theme.fg("dim", "□");
  const filled = theme.fg("muted", "■");
  const strength = level === "xhigh" ? 4 : level === "high" ? 3 : level === "medium" ? 2 : level === "low" || level === "minimal" ? 1 : 0;
  if (strength <= 0) return `${empty}${empty}${empty}${empty}`;
  if (strength === 1) return `${empty}${empty}${empty}${filled}`;
  if (strength === 2) return `${empty}${empty}${filled}${filled}`;
  if (strength === 3) return `${empty}${filled}${filled}${filled}`;
  return `${filled}${filled}${filled}${filled}`;
}

function padRightAnsi(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return text + " ".repeat(pad);
}

function getOverlayOptions(mode: DashboardOverlayMode): {
  width: string;
  maxHeight: string;
  minWidth: number;
  anchor: "center";
  margin: number;
} {
  if (mode === "full") {
    return {
      width: "99%",
      maxHeight: "96%",
      minWidth: 100,
      anchor: "center",
      margin: 0,
    };
  }
  if (mode === "wide") {
    return {
      width: "97%",
      maxHeight: "92%",
      minWidth: 96,
      anchor: "center",
      margin: 0,
    };
  }
  return {
    width: "92%",
    maxHeight: "85%",
    minWidth: 80,
    anchor: "center",
    margin: 1,
  };
}

function renderActiveItemLabel(item: DashboardItem, theme: any): string {
  if (item.kind === "active-session") {
    const marker = item.marker;
    const statusColor = marker.status === "running" ? "warning" : marker.status === "stale" ? "error" : "dim";
    const statusText = theme.fg(statusColor, marker.status === "running" ? "RUN" : marker.status === "stale" ? "STL" : "IDL");
    const repoText = marker.vcsEngine === "jj"
      ? `jj ${marker.workspace || "default"} ${marker.changeId || "?"}`
      : marker.vcsEngine === "git"
        ? `git ${marker.branch || "?"}${marker.head ? `@${marker.head}` : ""}`
        : basenameSafe(marker.cwd);
    const task = compactOneLine(marker.taskSummary || marker.phase || "", 34);
    return `${statusText} ${theme.fg("text", basenameSafe(marker.cwd))} · ${theme.fg("muted", repoText)}${task ? ` · ${theme.fg("dim", task)}` : ""}`;
  }

  if (item.kind === "active-iso") {
    const marker = item.marker;
    const status = theme.fg(marker.stale ? "error" : "warning", marker.stale ? "ISO!" : "ISO");
    const worktree = theme.fg("text", basenameSafe(marker.worktree));
    const task = compactOneLine(marker.task, 36);
    return `${status} ${worktree}${task ? ` · ${theme.fg("dim", task)}` : ""}`;
  }

  const session = item.session;
  const active = item.marker ? theme.fg("warning", "●") : theme.fg("dim", "○");
  const label = compactOneLine(session.name || session.firstMessage || basenameSafe(session.cwd), 42);
  return `${active} ${theme.fg("text", label)} · ${theme.fg("dim", timeAgo(session.modified))}`;
}

function renderDetailLines(item: DashboardItem | undefined, theme: any): string[] {
  if (!item) return [theme.fg("dim", "No item selected")];

  if (item.kind === "active-session") {
    const marker = item.marker;
    return [
      theme.bold(theme.fg("accent", marker.sessionName || basenameSafe(marker.sessionFile) || basenameSafe(marker.cwd))),
      `${theme.fg("dim", "status")} ${marker.status}`,
      `${theme.fg("dim", "cwd")} ${compactPath(marker.cwd)}`,
      `${theme.fg("dim", "repo")} ${compactPath(marker.repoRoot || marker.cwd)}`,
      `${theme.fg("dim", "vcs")} ${marker.vcsEngine === "jj" ? `jj ${marker.workspace || "default"} ${marker.changeId || "?"}` : marker.vcsEngine === "git" ? `git ${marker.branch || "?"}${marker.head ? `@${marker.head}` : ""}` : "none"}`,
      `${theme.fg("dim", "model")} ${marker.modelId || "none"} ${formatThinkingMeter(marker.thinkingLevel, theme)}`,
      `${theme.fg("dim", "profile")} ${marker.profile || "-"}/${marker.authMode || "unknown"}`,
      `${theme.fg("dim", "phase")} ${marker.phase || "idle"}`,
      `${theme.fg("dim", "tool")} ${marker.lastTool || "-"}`,
      `${theme.fg("dim", "task")} ${compactOneLine(marker.taskSummary || "-", 120)}`,
      `${theme.fg("dim", "updated")} ${timeAgo(marker.lastUpdate)} ago`,
      `${theme.fg("dim", "session")} ${marker.sessionFile ? compactPath(marker.sessionFile) : "ephemeral"}`,
      theme.fg("dim", "Enter switches to this session when available"),
    ];
  }

  if (item.kind === "active-iso") {
    const marker = item.marker;
    return [
      theme.bold(theme.fg("accent", marker.id)),
      `${theme.fg("dim", "status")} ${marker.stale ? "stale" : "running"}`,
      `${theme.fg("dim", "pid")} ${marker.pid || "?"}`,
      `${theme.fg("dim", "age")} ${timeAgo(marker.startedAt)} ago`,
      `${theme.fg("dim", "worktree")} ${compactPath(marker.worktree || "?")}`,
      `${theme.fg("dim", "task")} ${compactOneLine(marker.task || "-", 120)}`,
      theme.fg("dim", "ISO rows are observational; no direct switch action yet"),
    ];
  }

  const session = item.session;
  const marker = item.marker;
  return [
    theme.bold(theme.fg("accent", session.name || basenameSafe(session.path))),
    `${theme.fg("dim", "cwd")} ${compactPath(session.cwd)}`,
    `${theme.fg("dim", "modified")} ${session.modified.toLocaleString()} (${timeAgo(session.modified)} ago)`,
    `${theme.fg("dim", "messages")} ${session.messageCount}`,
    `${theme.fg("dim", "preview")} ${compactOneLine(session.firstMessage || "-", 120)}`,
    `${theme.fg("dim", "path")} ${compactPath(session.path)}`,
    `${theme.fg("dim", "active")} ${marker ? `${marker.status} · ${marker.modelId || "none"} ${formatThinkingMeter(marker.thinkingLevel, theme)}` : "no"}`,
    `${theme.fg("dim", "task")} ${compactOneLine(marker?.taskSummary || "-", 120)}`,
    theme.fg("dim", "Enter switches to this session"),
  ];
}

class DashboardComponent {
  private tab: DashboardTab = "active";
  private filter: FilterMode = "active";
  private selectedIndex = 0;
  private items: DashboardItem[] = [];
  private currentRepo?: string;
  private loading = true;
  private error?: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private selectionByTab: Record<DashboardTab, string | undefined> = { active: undefined, sessions: undefined };

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: any,
    private readonly tui: any,
    private readonly theme: any,
    private readonly done: (result: DashboardResult) => void,
    private readonly cfg: DashboardConfig,
  ) {
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, cfg.refreshMs);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  invalidate(): void {
    // no-op
  }

  private setSelectedById(id: string | undefined): void {
    if (!id) {
      this.selectedIndex = 0;
      return;
    }
    const nextIndex = this.items.findIndex((item) => item.id === id);
    this.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
  }

  private async refresh(): Promise<void> {
    try {
      this.loading = true;
      this.error = undefined;
      this.tui.requestRender();
      const data = await getDashboardData(this.pi, this.ctx, this.cfg);
      this.currentRepo = data.currentRepo;
      const allItems = this.tab === "active" ? data.activeItems : data.sessionItems;
      const filtered = allItems.filter((item) => this.matchesFilter(item));
      this.items = filtered;
      this.setSelectedById(this.selectionByTab[this.tab]);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.items = [];
    } finally {
      this.loading = false;
      this.tui.requestRender();
    }
  }

  private matchesFilter(item: DashboardItem): boolean {
    if (this.filter === "all") return true;
    if (this.filter === "active") {
      if (item.kind === "session") return Boolean(item.marker);
      return true;
    }
    const repo = this.currentRepo;
    if (!repo) return true;
    if (item.kind === "active-session") {
      return (item.marker.repoRoot || item.marker.cwd).startsWith(repo);
    }
    if (item.kind === "active-iso") {
      return (item.marker.worktree || "").startsWith(repo);
    }
    return item.session.cwd.startsWith(repo);
  }

  private selectedItem(): DashboardItem | undefined {
    return this.items[this.selectedIndex];
  }

  private move(delta: number): void {
    if (this.items.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
    this.selectionByTab[this.tab] = this.items[this.selectedIndex]?.id;
  }

  private cycleTab(direction: 1 | -1): void {
    this.selectionByTab[this.tab] = this.selectedItem()?.id;
    this.tab = direction > 0 ? (this.tab === "active" ? "sessions" : "active") : (this.tab === "sessions" ? "active" : "sessions");
    this.selectedIndex = 0;
    void this.refresh();
  }

  private cycleFilter(): void {
    this.filter = this.filter === "active" ? "repo" : this.filter === "repo" ? "all" : "active";
    void this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, "up")) {
      this.move(-1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.move(1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.move(-10);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.move(10);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.cycleTab(1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.cycleTab(-1);
      return;
    }
    if (data === "f" || data === "F") {
      this.cycleFilter();
      return;
    }
    if (data === "r" || data === "R") {
      void this.refresh();
      return;
    }
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const item = this.selectedItem();
      if (!item) {
        this.done({ action: "noop" });
        return;
      }
      if (item.kind === "active-session" && item.marker.sessionFile) {
        this.done({ action: "switch-session", sessionPath: item.marker.sessionFile });
        return;
      }
      if (item.kind === "session") {
        this.done({ action: "switch-session", sessionPath: item.session.path });
        return;
      }
      this.done({ action: "noop" });
    }
  }

  render(width: number): string[] {
    const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
    const leftWidth = Math.max(32, Math.min(Math.floor(width * 0.44), width - 24));
    const rightWidth = Math.max(20, width - leftWidth - 3);
    const terminalRows = typeof process.stdout.rows === "number" ? process.stdout.rows : 24;
    const desiredRows = this.cfg.overlayMode === "full"
      ? terminalRows - 6
      : this.cfg.overlayMode === "wide"
        ? terminalRows - 8
        : terminalRows - 12;
    const rows = Math.max(14, Math.min(40, desiredRows));

    const title = this.theme.bold(this.theme.fg("accent", "Pi Dashboard"));
    const tabs = [
      this.tab === "active" ? this.theme.fg("accent", "[Active]") : this.theme.fg("dim", " Active "),
      this.tab === "sessions" ? this.theme.fg("accent", "[Sessions]") : this.theme.fg("dim", " Sessions "),
    ].join(this.theme.fg("dim", " "));
    const filter = this.theme.fg("dim", `filter:${this.filter}`);
    const header = truncateToWidth(`${title} ${this.theme.fg("dim", "·")} ${tabs} ${this.theme.fg("dim", "·")} ${filter}`, width);

    const visibleItems = this.items;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(rows / 2), Math.max(0, visibleItems.length - rows)));
    const windowItems = visibleItems.slice(start, start + rows);
    const leftLines: string[] = [];

    if (this.loading && visibleItems.length === 0) {
      leftLines.push(this.theme.fg("dim", "Loading dashboard state…"));
    } else if (this.error) {
      leftLines.push(this.theme.fg("error", this.error));
    } else if (windowItems.length === 0) {
      leftLines.push(this.theme.fg("dim", "No items for this view/filter"));
    } else {
      for (let i = 0; i < windowItems.length; i++) {
        const absoluteIndex = start + i;
        const item = windowItems[i]!;
        const selected = absoluteIndex === this.selectedIndex;
        const prefix = selected ? this.theme.fg("accent", "▶ ") : this.theme.fg("dim", "  ");
        const text = renderActiveItemLabel(item, this.theme);
        leftLines.push(truncateToWidth(prefix + text, leftWidth));
      }
    }

    while (leftLines.length < rows) leftLines.push("");

    const rightLines = renderDetailLines(this.selectedItem(), this.theme).map((line) => truncateToWidth(line, rightWidth));
    while (rightLines.length < rows) rightLines.push("");

    const body: string[] = [];
    for (let i = 0; i < rows; i++) {
      body.push(`${padRightAnsi(leftLines[i] || "", leftWidth)} ${this.theme.fg("dim", "│")} ${padRightAnsi(rightLines[i] || "", rightWidth)}`);
    }

    const footer = this.theme.fg("dim", "↑↓ move • Tab/←→ switch tab • f filter • r refresh • Enter switch • Esc close");

    return [
      header,
      border,
      ...body,
      border,
      truncateToWidth(footer, width),
    ];
  }
}

async function openDashboard(pi: ExtensionAPI, ctx: any): Promise<DashboardResult> {
  const cfg = loadConfig(ctx.cwd);
  if (!cfg.enabled) {
    ctx.ui.notify("agent-dashboard is disabled. Run /agent-dashboard on", "warning");
    return null;
  }

  return ctx.ui.custom<DashboardResult>((tui, theme, _kb, done) => new DashboardComponent(pi, ctx, tui, theme, done, cfg), {
    overlay: true,
    overlayOptions: getOverlayOptions(cfg.overlayMode),
  });
}

function describeToolCall(event: any): { phase: string; summary: string } {
  const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
  if (toolName === "bash") {
    return {
      phase: "tool:bash",
      summary: compactOneLine(String(event.input?.command || "bash"), 96),
    };
  }
  if (toolName === "read") {
    return {
      phase: "tool:read",
      summary: compactOneLine(`read ${String(event.input?.path || "")}`, 96),
    };
  }
  if (toolName === "edit" || toolName === "write") {
    return {
      phase: `tool:${toolName}`,
      summary: compactOneLine(`${toolName} ${String(event.input?.path || "")}`, 96),
    };
  }
  if (toolName === "find" || toolName === "grep" || toolName === "ls") {
    return {
      phase: `tool:${toolName}`,
      summary: compactOneLine(`${toolName} ${String(event.input?.path || event.input?.pattern || "")}`, 96),
    };
  }
  return {
    phase: `tool:${toolName}`,
    summary: compactOneLine(toolName, 96),
  };
}

export default function agentDashboard(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await updateActivityMarker(pi, ctx, { status: "idle", phase: "idle" });
  });

  pi.on("model_select", async (_event, ctx) => {
    await updateActivityMarker(pi, ctx, {});
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = typeof event.prompt === "string" ? compactOneLine(event.prompt, 120) : undefined;
    await updateActivityMarker(pi, ctx, {
      status: "running",
      phase: "thinking",
      taskSummary: prompt || currentMarker?.taskSummary,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    const tool = describeToolCall(event);
    await updateActivityMarker(pi, ctx, {
      status: "running",
      phase: tool.phase,
      lastTool: event.toolName,
      taskSummary: currentMarker?.taskSummary || tool.summary,
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    await updateActivityMarker(pi, ctx, {
      status: "running",
      phase: event.isError ? `error:${event.toolName}` : `tool:${event.toolName}:done`,
      lastTool: event.toolName,
    });
  });

  pi.on("turn_end", async (_event, ctx) => {
    await updateActivityMarker(pi, ctx, {
      status: "idle",
      phase: "idle",
    });
  });

  pi.on("session_shutdown", async () => {
    removeCurrentMarker();
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "Open agent dashboard",
    handler: async (ctx) => {
      const result = await openDashboard(pi, ctx);
      if (!result || result.action !== "switch-session") return;
      if (result.sessionPath === getSessionFile(ctx)) {
        ctx.ui.notify("Already in that session", "info");
        return;
      }
      if (typeof ctx.waitForIdle === "function" && typeof ctx.switchSession === "function") {
        await ctx.waitForIdle();
        const switched = await ctx.switchSession(result.sessionPath);
        if (switched.cancelled) {
          ctx.ui.notify("Dashboard switch cancelled", "warning");
        }
        return;
      }
      if (typeof ctx.ui?.setEditorText === "function") {
        ctx.ui.setEditorText(`/resume\n# switch to: ${result.sessionPath}`);
        ctx.ui.notify("Inserted session switch hint into editor", "info");
      }
    },
  });

  pi.registerCommand("dashboard", {
    description: "Open the global Pi dashboard",
    handler: async (_args, ctx) => {
      const result = await openDashboard(pi, ctx);
      if (!result || result.action !== "switch-session") return;
      if (result.sessionPath === getSessionFile(ctx)) {
        ctx.ui.notify("Already in that session", "info");
        return;
      }
      await ctx.waitForIdle();
      const switched = await ctx.switchSession(result.sessionPath);
      if (switched.cancelled) {
        ctx.ui.notify("Dashboard switch cancelled", "warning");
      }
    },
  });

  pi.registerCommand("agent-dashboard", {
    description: "Agent dashboard: on|off|open|show|normal|wide|full",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();
      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        await updateActivityMarker(pi, ctx, { status: ctx.isIdle() ? "idle" : "running" });
        ctx.ui.notify("agent-dashboard enabled", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        removeCurrentMarker();
        ctx.ui.notify("agent-dashboard disabled", "success");
        return;
      }
      if (cmd === "normal" || cmd === "wide" || cmd === "full") {
        writeGlobalConfig({ overlayMode: cmd });
        ctx.ui.notify(`agent-dashboard overlay mode: ${cmd}`, "success");
        return;
      }
      if (cmd === "open") {
        const result = await openDashboard(pi, ctx);
        if (result?.action === "switch-session" && result.sessionPath !== getSessionFile(ctx)) {
          await ctx.waitForIdle();
          await ctx.switchSession(result.sessionPath);
        }
        return;
      }

      const cfg = loadConfig(ctx.cwd);
      ctx.ui.notify(
        `agent-dashboard enabled=${cfg.enabled} overlayMode=${cfg.overlayMode} refreshMs=${cfg.refreshMs} staleAfterMs=${cfg.staleAfterMs} recentSessionCount=${cfg.recentSessionCount}`,
        "info",
      );
    },
  });
}
