import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

type GroupedToolsConfig = { enabled: boolean };

const DEFAULT_CONFIG: GroupedToolsConfig = { enabled: true };

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

function loadConfig(cwd: string): GroupedToolsConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.groupedToolsV2 && typeof global.groupedToolsV2 === "object"
    ? (global.groupedToolsV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const p = (project.groupedToolsV2 && typeof project.groupedToolsV2 === "object"
    ? (project.groupedToolsV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const enabled = typeof p.enabled === "boolean" ? p.enabled : typeof g.enabled === "boolean" ? g.enabled : DEFAULT_CONFIG.enabled;
  return { enabled };
}

function writeGlobalConfig(partial: Partial<GroupedToolsConfig>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJson(settingsPath);
  const existing = current.groupedToolsV2 && typeof current.groupedToolsV2 === "object"
    ? (current.groupedToolsV2 as Record<string, unknown>)
    : {};
  current.groupedToolsV2 = { ...existing, ...partial };
  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function summarizeCalls(calls: Array<{ name: string }>): string[] {
  if (calls.length === 0) return [];
  const groups: Array<{ name: string; count: number }> = [];

  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (last && last.name === call.name) {
      last.count += 1;
    } else {
      groups.push({ name: call.name, count: 1 });
    }
  }

  return groups.map((g) => (g.count > 1 ? `${g.name} x${g.count}` : g.name));
}

export default function groupedToolsV2(pi: ExtensionAPI) {
  pi.registerMessageRenderer("grouped-tools-v2", (message, theme) => {
    const details = (message.details || {}) as { lines?: string[] };
    const lines = details.lines || [];
    const header = theme.bold(theme.fg("accent", "Tool Summary"));
    const body = lines.length > 0 ? lines.map((line) => `${theme.fg("muted", "- ")}${theme.fg("dim", line)}`).join("\n") : theme.fg("dim", "(no tools)");
    return new Text(`${header}\n${body}`, 0, 0);
  });

  pi.on("turn_end", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return;

    const assistantMessage = event.message;
    if (!assistantMessage || assistantMessage.role !== "assistant") return;

    const toolCalls = (assistantMessage.content || [])
      .filter((part: any) => part && part.type === "toolCall" && typeof part.name === "string")
      .map((part: any) => ({ name: String(part.name) }));

    if (toolCalls.length < 2) return;

    const lines = summarizeCalls(toolCalls);
    if (lines.length <= 1 && !lines[0]?.includes("x")) return;

    pi.sendMessage({
      customType: "grouped-tools-v2",
      content: `Grouped tool summary: ${lines.join(", ")}`,
      details: { lines },
      display: true,
    });
  });

  pi.registerCommand("grouped-tools-v2", {
    description: "Grouped tools v2: on|off|show",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();
      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        ctx.ui.notify("grouped-tools-v2 enabled", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        ctx.ui.notify("grouped-tools-v2 disabled", "success");
        return;
      }
      const cfg = loadConfig(ctx.cwd);
      ctx.ui.notify(`grouped-tools-v2 enabled=${cfg.enabled}`, "info");
    },
  });
}
