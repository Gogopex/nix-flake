import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

type VcsConfig = {
  enabled: boolean;
  preferJj: boolean;
  pollMs: number;
  maxIsolatedSlots: number;
  showAvail: boolean;
};

type CmdResult = { code: number; stdout: string; stderr: string };

type IsoMarker = {
  file: string;
  id: string;
  pid: number;
  startedAt: number;
  worktree: string;
  task: string;
  stale: boolean;
};

type Snapshot = {
  engine: "jj" | "git" | "none";
  vcsLine: string;
  root?: string;
  jj?: {
    currentWorkspace: string;
    changeId: string;
    workspaces: string[];
    dirty: boolean;
  };
  git?: {
    branch: string;
    head: string;
    dirty: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicts: number;
    ahead: number;
    behind: number;
    worktrees: Array<{ path: string; branch?: string; head?: string; detached?: boolean }>;
  };
  iso: {
    running: number;
    stale: number;
    available: number;
    markers: IsoMarker[];
    orphanDirs: string[];
  };
};

const DEFAULT_CONFIG: VcsConfig = {
  enabled: false,
  preferJj: true,
  pollMs: 1500,
  maxIsolatedSlots: 4,
  showAvail: true,
};

let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let currentCtx: any = null;

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getIsoDir(): string {
  return path.join(getAgentDir(), "wt");
}

function getIsoActiveDir(): string {
  return path.join(getIsoDir(), "active");
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeGlobalConfig(partial: Partial<VcsConfig>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJson(settingsPath);
  const existing = current.vcsStatusV2 && typeof current.vcsStatusV2 === "object"
    ? (current.vcsStatusV2 as Record<string, unknown>)
    : {};
  current.vcsStatusV2 = { ...existing, ...partial };
  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function loadConfig(cwd: string): VcsConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.vcsStatusV2 && typeof global.vcsStatusV2 === "object"
    ? (global.vcsStatusV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const p = (project.vcsStatusV2 && typeof project.vcsStatusV2 === "object"
    ? (project.vcsStatusV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const enabled = typeof p.enabled === "boolean" ? p.enabled : typeof g.enabled === "boolean" ? g.enabled : DEFAULT_CONFIG.enabled;
  const preferJj = typeof p.preferJj === "boolean" ? p.preferJj : typeof g.preferJj === "boolean" ? g.preferJj : DEFAULT_CONFIG.preferJj;
  const pollRaw = typeof p.pollMs === "number" ? p.pollMs : typeof g.pollMs === "number" ? g.pollMs : DEFAULT_CONFIG.pollMs;
  const slotsRaw = typeof p.maxIsolatedSlots === "number" ? p.maxIsolatedSlots : typeof g.maxIsolatedSlots === "number" ? g.maxIsolatedSlots : DEFAULT_CONFIG.maxIsolatedSlots;
  const showAvail = typeof p.showAvail === "boolean" ? p.showAvail : typeof g.showAvail === "boolean" ? g.showAvail : DEFAULT_CONFIG.showAvail;

  return {
    enabled,
    preferJj,
    pollMs: Math.max(500, Math.min(10000, Math.floor(pollRaw))),
    maxIsolatedSlots: Math.max(1, Math.min(64, Math.floor(slotsRaw))),
    showAvail,
  };
}

async function exec(pi: ExtensionAPI, cwd: string, command: string, args: string[]): Promise<CmdResult> {
  try {
    const result = await pi.exec(command, args, { cwd, timeout: 8000 });
    return {
      code: typeof result.code === "number" ? result.code : 1,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function parseGitStatus(porcelain: string): { staged: number; unstaged: number; untracked: number; conflicts: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";

    if (x === "?" && y === "?") {
      untracked += 1;
      continue;
    }

    if (x !== " " && x !== "?") staged += 1;
    if (y !== " ") unstaged += 1;
    if (x === "U" || y === "U") conflicts += 1;
  }

  return { staged, unstaged, untracked, conflicts };
}

function parseGitWorktrees(porcelain: string): Array<{ path: string; branch?: string; head?: string; detached?: boolean }> {
  const out: Array<{ path: string; branch?: string; head?: string; detached?: boolean }> = [];
  let current: { path: string; branch?: string; head?: string; detached?: boolean } | null = null;

  for (const line of porcelain.split("\n")) {
    if (!line.trim()) {
      if (current) out.push(current);
      current = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim().slice(0, 8);
    else if (line.startsWith("branch ")) {
      const full = line.slice("branch ".length).trim();
      current.branch = full.replace("refs/heads/", "");
    } else if (line.trim() === "detached") {
      current.detached = true;
    }
  }

  if (current) out.push(current);
  return out;
}

function parseJjWorkspaceList(output: string): { currentWorkspace: string; all: string[] } {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return { currentWorkspace: "default", all: [] };

  const names: string[] = [];
  let current = "default";

  for (const line of lines) {
    const isCurrent = line.includes("*");
    const cleaned = line.replace("*", "").trim();
    const name = cleaned.includes(":") ? cleaned.split(":")[0].trim() : cleaned.split(/\s+/)[0];
    if (!name) continue;
    names.push(name);
    if (isCurrent) current = name;
  }

  if (!names.includes(current) && names.length > 0) {
    current = names[0];
  }

  return { currentWorkspace: current, all: names };
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

function readIsoMarkers(maxSlots: number): { running: number; stale: number; available: number; markers: IsoMarker[]; orphanDirs: string[] } {
  const activeDir = getIsoActiveDir();
  const markers: IsoMarker[] = [];

  if (fs.existsSync(activeDir)) {
    for (const file of fs.readdirSync(activeDir)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(activeDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
        const marker: IsoMarker = {
          file: full,
          id: String(data.id || file.replace(/\.json$/, "")),
          pid: Number(data.pid || 0),
          startedAt: Number(data.startedAt || 0),
          worktree: String(data.worktree || ""),
          task: String(data.task || ""),
          stale: false,
        };
        const missingWorktree = !marker.worktree || !fs.existsSync(marker.worktree);
        const deadProcess = !processExists(marker.pid);
        marker.stale = missingWorktree || deadProcess;
        markers.push(marker);
      } catch {
        markers.push({ file: full, id: file, pid: 0, startedAt: 0, worktree: "", task: "", stale: true });
      }
    }
  }

  const running = markers.filter((m) => !m.stale).length;
  const stale = markers.filter((m) => m.stale).length;

  const wtDir = getIsoDir();
  const markerWorktrees = new Set(markers.map((m) => m.worktree));
  const orphanDirs: string[] = [];
  if (fs.existsSync(wtDir)) {
    for (const entry of fs.readdirSync(wtDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("iso-")) continue;
      const full = path.join(wtDir, entry.name);
      if (!markerWorktrees.has(full)) {
        orphanDirs.push(full);
      }
    }
  }

  return {
    running,
    stale,
    available: Math.max(0, maxSlots - running),
    markers,
    orphanDirs,
  };
}

async function collectSnapshot(pi: ExtensionAPI, cwd: string, cfg: VcsConfig): Promise<Snapshot> {
  const iso = readIsoMarkers(cfg.maxIsolatedSlots);

  const jjRoot = await exec(pi, cwd, "jj", ["root"]);
  const gitRoot = await exec(pi, cwd, "git", ["rev-parse", "--show-toplevel"]);

  const hasJj = jjRoot.code === 0;
  const hasGit = gitRoot.code === 0;

  const engine: "jj" | "git" | "none" = cfg.preferJj ? (hasJj ? "jj" : hasGit ? "git" : "none") : (hasGit ? "git" : hasJj ? "jj" : "none");

  if (engine === "jj") {
    const root = jjRoot.stdout.trim();
    const wsRes = await exec(pi, root, "jj", ["workspace", "list", "--color", "never"]);
    const statusRes = await exec(pi, root, "jj", ["status", "--color", "never"]);
    const changeRes = await exec(pi, root, "jj", ["log", "-r", "@", "-T", "change_id.short()", "--no-graph", "--color", "never"]);

    const ws = parseJjWorkspaceList(wsRes.stdout);
    const changeId = (changeRes.stdout.trim() || "?").split(/\s+/)[0];
    const dirty = !/no changes/i.test(statusRes.stdout);

    return {
      engine,
      root,
      vcsLine: `jj ws=${ws.currentWorkspace} ch=${changeId}${dirty ? "*" : ""}`,
      jj: {
        currentWorkspace: ws.currentWorkspace,
        changeId,
        workspaces: ws.all,
        dirty,
      },
      iso,
    };
  }

  if (engine === "git") {
    const root = gitRoot.stdout.trim();
    const branchRes = await exec(pi, root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const headRes = await exec(pi, root, "git", ["rev-parse", "--short", "HEAD"]);
    const statusRes = await exec(pi, root, "git", ["status", "--porcelain"]);
    const aheadBehindRes = await exec(pi, root, "git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const worktreeRes = await exec(pi, root, "git", ["worktree", "list", "--porcelain"]);

    const branch = branchRes.stdout.trim() || "detached";
    const head = headRes.stdout.trim() || "?";
    const counts = parseGitStatus(statusRes.stdout);
    const dirty = counts.staged + counts.unstaged + counts.untracked + counts.conflicts > 0;

    let behind = 0;
    let ahead = 0;
    const ab = aheadBehindRes.stdout.trim().split(/\s+/);
    if (ab.length >= 2) {
      behind = Number.parseInt(ab[0], 10) || 0;
      ahead = Number.parseInt(ab[1], 10) || 0;
    }

    const worktrees = parseGitWorktrees(worktreeRes.stdout);

    return {
      engine,
      root,
      vcsLine: `git wt=${branch}@${head}${dirty ? "*" : ""} +${counts.staged} ~${counts.unstaged} ?${counts.untracked} !${counts.conflicts}${ahead || behind ? ` ↑${ahead} ↓${behind}` : ""}`,
      git: {
        branch,
        head,
        dirty,
        staged: counts.staged,
        unstaged: counts.unstaged,
        untracked: counts.untracked,
        conflicts: counts.conflicts,
        ahead,
        behind,
        worktrees,
      },
      iso,
    };
  }

  return {
    engine: "none",
    vcsLine: "none",
    iso,
  };
}

function clearStatuses(ctx: any): void {
  if (!ctx?.ui?.setStatus) return;
  ctx.ui.setStatus("vcs-v2", undefined);
  ctx.ui.setStatus("iso-v2", undefined);
  ctx.ui.setStatus("avail-v2", undefined);
}

async function updateStatuses(pi: ExtensionAPI): Promise<void> {
  if (polling || !currentCtx || !currentCtx?.ui?.setStatus) return;
  polling = true;
  const ctx = currentCtx;
  try {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) {
      clearStatuses(ctx);
      return;
    }

    const snapshot = await collectSnapshot(pi, ctx.cwd, cfg);
    if (currentCtx !== ctx || !ctx?.ui?.setStatus) return;

    ctx.ui.setStatus("vcs-v2", snapshot.vcsLine);
    ctx.ui.setStatus("iso-v2", String(snapshot.iso.running));
    if (cfg.showAvail) {
      ctx.ui.setStatus("avail-v2", String(snapshot.iso.available));
    } else {
      ctx.ui.setStatus("avail-v2", undefined);
    }
  } finally {
    polling = false;
  }
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(pi: ExtensionAPI, ctx: any): void {
  if (!ctx?.ui?.setStatus) {
    currentCtx = null;
    stopPolling();
    return;
  }
  currentCtx = ctx;
  stopPolling();
  void updateStatuses(pi).catch(() => {});

  const cfg = loadConfig(ctx.cwd);
  pollTimer = setInterval(() => {
    void updateStatuses(pi).catch(() => {});
  }, cfg.pollMs);
}

function renderTopologyMarkdown(snapshot: Snapshot, cfg: VcsConfig): string {
  const lines: string[] = [];
  lines.push(`# VCS Topology`);
  lines.push(``);
  lines.push(`- Engine: **${snapshot.engine}**`);
  lines.push(`- VCS: \`${snapshot.vcsLine}\``);
  lines.push(`- Isolated running: **${snapshot.iso.running}**`);
  lines.push(`- Isolated stale: **${snapshot.iso.stale}**`);
  lines.push(`- Slots: **${snapshot.iso.running}/${cfg.maxIsolatedSlots}** (avail ${snapshot.iso.available})`);

  if (snapshot.jj) {
    lines.push(``);
    lines.push(`## JJ`);
    lines.push(`- Current workspace: **${snapshot.jj.currentWorkspace}**`);
    lines.push(`- Change: \`${snapshot.jj.changeId}\`${snapshot.jj.dirty ? " (dirty)" : " (clean)"}`);
    lines.push(`- Workspaces (${snapshot.jj.workspaces.length}):`);
    for (const ws of snapshot.jj.workspaces) {
      lines.push(`  - ${ws}${ws === snapshot.jj.currentWorkspace ? " *(current)*" : ""}`);
    }
    lines.push(`- Hint: remove stale workspace with \`jj workspace forget <name>\``);
  }

  if (snapshot.git) {
    lines.push(``);
    lines.push(`## Git`);
    lines.push(`- Branch: **${snapshot.git.branch}** @ \`${snapshot.git.head}\``);
    lines.push(`- Dirty: ${snapshot.git.dirty ? "yes" : "no"}`);
    lines.push(`- Changes: +${snapshot.git.staged} ~${snapshot.git.unstaged} ?${snapshot.git.untracked} !${snapshot.git.conflicts}`);
    lines.push(`- Ahead/behind: ↑${snapshot.git.ahead} ↓${snapshot.git.behind}`);
    lines.push(`- Worktrees (${snapshot.git.worktrees.length}):`);
    for (const wt of snapshot.git.worktrees) {
      const label = wt.branch || (wt.detached ? "detached" : "unknown");
      lines.push(`  - \`${wt.path}\` (${label}${wt.head ? ` @ ${wt.head}` : ""})`);
    }
  }

  lines.push(``);
  lines.push(`## Isolated task markers`);
  if (snapshot.iso.markers.length === 0) {
    lines.push(`- none`);
  } else {
    for (const marker of snapshot.iso.markers) {
      const ageMin = marker.startedAt > 0 ? Math.max(0, Math.floor((Date.now() - marker.startedAt) / 60000)) : 0;
      lines.push(
        `- ${marker.stale ? "[STALE]" : "[RUNNING]"} \`${marker.id}\` pid=${marker.pid} age=${ageMin}m wt=\`${marker.worktree || "?"}\``,
      );
    }
  }

  if (snapshot.iso.orphanDirs.length > 0) {
    lines.push(``);
    lines.push(`## Orphan worktree dirs`);
    for (const dir of snapshot.iso.orphanDirs) {
      lines.push(`- \`${dir}\``);
    }
    lines.push(`- Hint: remove with \`git worktree remove -f <dir>\` then \`rm -rf <dir>\` if needed`);
  }

  return lines.join("\n");
}

export default function vcsStatusV2(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) {
      clearStatuses(ctx);
      return;
    }
    startPolling(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    currentCtx = null;
  });

  pi.registerCommand("vcs-status-v2", {
    description: "VCS status v2: on|off|show|refresh",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();

      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        startPolling(pi, ctx);
        ctx.ui.notify("vcs-status-v2 enabled", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        stopPolling();
        clearStatuses(ctx);
        ctx.ui.notify("vcs-status-v2 disabled", "success");
        return;
      }
      if (cmd === "refresh") {
        currentCtx = ctx;
        await updateStatuses(pi);
        ctx.ui.notify("vcs-status-v2 refreshed", "info");
        return;
      }

      const cfg = loadConfig(ctx.cwd);
      const snapshot = await collectSnapshot(pi, ctx.cwd, cfg);
      ctx.ui.notify(
        `vcs-status-v2 enabled=${cfg.enabled} engine=${snapshot.engine} pollMs=${cfg.pollMs} slots=${cfg.maxIsolatedSlots}`,
        "info",
      );
    },
  });

  pi.registerCommand("vcs-topology", {
    description: "Show detailed VCS/workspace/worktree topology",
    handler: async (_args, ctx) => {
      const cfg = loadConfig(ctx.cwd);
      const snapshot = await collectSnapshot(pi, ctx.cwd, cfg);
      const markdown = renderTopologyMarkdown(snapshot, cfg);

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.bold(theme.fg("accent", "VCS Topology")), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(markdown, 1, 0, getMarkdownTheme()));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "Press Enter/Esc to close"), 1, 0));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: () => done(undefined),
        };
      });
    },
  });
}
