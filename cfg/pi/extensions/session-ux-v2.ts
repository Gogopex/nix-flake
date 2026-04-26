import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@mariozechner/pi-tui";

type SessionUxConfig = { enabled: boolean; autoTitle: boolean; recentCount: number };

const DEFAULT_CONFIG: SessionUxConfig = { enabled: true, autoTitle: true, recentCount: 12 };

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function loadConfig(cwd: string): SessionUxConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.sessionUxV2 && typeof global.sessionUxV2 === "object"
    ? (global.sessionUxV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const p = (project.sessionUxV2 && typeof project.sessionUxV2 === "object"
    ? (project.sessionUxV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const enabled = typeof p.enabled === "boolean" ? p.enabled : typeof g.enabled === "boolean" ? g.enabled : DEFAULT_CONFIG.enabled;
  const autoTitle = typeof p.autoTitle === "boolean" ? p.autoTitle : typeof g.autoTitle === "boolean" ? g.autoTitle : DEFAULT_CONFIG.autoTitle;
  const recentCountRaw = typeof p.recentCount === "number" ? p.recentCount : typeof g.recentCount === "number" ? g.recentCount : DEFAULT_CONFIG.recentCount;
  const recentCount = Math.max(5, Math.min(40, Math.floor(recentCountRaw)));

  return { enabled, autoTitle, recentCount };
}

function writeGlobalConfig(partial: Partial<SessionUxConfig>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJson(settingsPath);
  const existing = current.sessionUxV2 && typeof current.sessionUxV2 === "object"
    ? (current.sessionUxV2 as Record<string, unknown>)
    : {};
  current.sessionUxV2 = { ...existing, ...partial };
  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function compactTitle(input: string): string {
  const firstLine = input.replace(/\s+/g, " ").trim();
  if (!firstLine) return "Untitled";
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
}

function collectRecentSessions(limit: number): Array<{ file: string; mtimeMs: number }> {
  const sessionsDir = path.join(getAgentDir(), "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const files: Array<{ file: string; mtimeMs: number }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".jsonl")) {
        try {
          files.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  };

  walk(sessionsDir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}

export default function sessionUxV2(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled || !cfg.autoTitle) return;

    const currentName = pi.getSessionName();
    if (currentName && currentName.trim().length > 0) return;

    const branch = ctx.sessionManager.getBranch();
    const hasUserMessages = branch.some((entry: any) => entry.type === "message" && entry.message?.role === "user");
    if (hasUserMessages) return;

    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const title = compactTitle(prompt);
    if (title && title !== "Untitled") {
      pi.setSessionName(title);
      ctx.ui.notify(`Session named: ${title}`, "info");
    }
  });

  pi.registerCommand("recent-v2", {
    description: "Show recent sessions and insert a resume hint",
    handler: async (_args, ctx) => {
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.enabled) {
        ctx.ui.notify("session-ux-v2 disabled", "warning");
        return;
      }

      const sessions = collectRecentSessions(cfg.recentCount);
      if (sessions.length === 0) {
        ctx.ui.notify("No recent sessions", "info");
        return;
      }

      const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.bold(theme.fg("accent", "Recent Sessions")), 1, 0));
        container.addChild(new Spacer(1));

        const items = sessions.map((s, i) => {
          const id = path.basename(s.file, ".jsonl");
          return {
            value: String(i),
            label: id,
            description: new Date(s.mtimeMs).toLocaleString(),
          };
        });

        const list = new SelectList(items, Math.min(12, items.length), {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("text", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);

        container.addChild(list);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "Enter picks; inserts /resume hint in editor"), 1, 0));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (picked === null) return;
      const idx = Number(picked);
      if (!Number.isFinite(idx) || idx < 0 || idx >= sessions.length) return;

      const id = path.basename(sessions[idx].file, ".jsonl");
      ctx.ui.setEditorText(`/resume\n# pick session: ${id}`);
      ctx.ui.notify("Inserted /resume hint into editor", "success");
    },
  });

  pi.registerCommand("session-ux-v2", {
    description: "Session UX v2: on|off|show",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();
      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        ctx.ui.notify("session-ux-v2 enabled", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        ctx.ui.notify("session-ux-v2 disabled", "success");
        return;
      }

      const cfg = loadConfig(ctx.cwd);
      ctx.ui.notify(
        `session-ux-v2 enabled=${cfg.enabled} autoTitle=${cfg.autoTitle} recentCount=${cfg.recentCount}`,
        "info",
      );
    },
  });
}
