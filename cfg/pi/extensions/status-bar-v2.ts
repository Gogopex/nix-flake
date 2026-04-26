import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

type ProfileMode = "personal" | "work";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type StatusBarV2Config = {
  enabled: boolean;
  profile: ProfileMode;
  showAuth: boolean;
  compactFooter: boolean;
};

const DEFAULT_CONFIG: StatusBarV2Config = {
  enabled: false,
  profile: "personal",
  showAuth: true,
  compactFooter: false,
};

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getNested(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseConfigFromObject(raw: Record<string, unknown>): Partial<StatusBarV2Config> {
  const block = getNested(raw, "statusBarV2");
  if (!block || typeof block !== "object") return {};
  const settings = block as Record<string, unknown>;

  const enabled = typeof settings.enabled === "boolean" ? settings.enabled : undefined;
  const profileRaw = typeof settings.profile === "string" ? settings.profile.toLowerCase() : undefined;
  const profile = profileRaw === "work" || profileRaw === "personal" ? (profileRaw as ProfileMode) : undefined;
  const showAuth = typeof settings.showAuth === "boolean" ? settings.showAuth : undefined;
  const compactFooter = typeof settings.compactFooter === "boolean" ? settings.compactFooter : undefined;

  return { enabled, profile, showAuth, compactFooter };
}

function loadConfig(cwd: string): StatusBarV2Config {
  const globalSettingsPath = path.join(getAgentDir(), "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");

  const globalConfig = parseConfigFromObject(readJsonFile(globalSettingsPath));
  const projectConfig = parseConfigFromObject(readJsonFile(projectSettingsPath));

  return {
    enabled: projectConfig.enabled ?? globalConfig.enabled ?? DEFAULT_CONFIG.enabled,
    profile: projectConfig.profile ?? globalConfig.profile ?? DEFAULT_CONFIG.profile,
    showAuth: projectConfig.showAuth ?? globalConfig.showAuth ?? DEFAULT_CONFIG.showAuth,
    compactFooter: projectConfig.compactFooter ?? globalConfig.compactFooter ?? DEFAULT_CONFIG.compactFooter,
  };
}

function writeGlobalConfig(partial: Partial<StatusBarV2Config>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJsonFile(settingsPath);
  const existingBlock = (current.statusBarV2 && typeof current.statusBarV2 === "object"
    ? (current.statusBarV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  current.statusBarV2 = {
    ...existingBlock,
    ...partial,
  };

  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function compactPath(cwd: string): string {
  const home = os.homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function normalizeUsagePercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent > 1) return Math.max(0, Math.min(1, percent / 100));
  return Math.max(0, Math.min(1, percent));
}

function compactTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${Math.round(value)}`;
}

function colorUsagePercent(theme: any, fraction: number): string {
  const percent = `${Math.round(fraction * 100)}%`;
  if (fraction >= 0.9) return theme.fg("error", percent);
  if (fraction >= 0.7) return theme.fg("warning", percent);
  if (fraction >= 0.5) return theme.fg("accent", percent);
  return theme.fg("dim", percent);
}

function formatContextPct(ctx: any, theme: any): string {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const pct = usage?.percent;
  if (typeof pct !== "number" || Number.isNaN(pct)) {
    return theme.fg("dim", "?");
  }

  const fraction = normalizeUsagePercent(pct);
  const display = `${Math.round(fraction * 100)}%`;
  if (fraction > 0.9) return theme.fg("error", display);
  if (fraction > 0.7) return theme.fg("warning", display);
  return theme.fg("dim", display);
}

function getContextWindow(ctx: any): number | undefined {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  if (typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
    return usage.contextWindow;
  }
  if (typeof ctx.model?.contextWindow === "number" && Number.isFinite(ctx.model.contextWindow) && ctx.model.contextWindow > 0) {
    return ctx.model.contextWindow;
  }
  return undefined;
}

function formatContextCompact(ctx: any, theme: any): string {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : undefined;
  const contextWindow = getContextWindow(ctx);

  const fraction = typeof usage?.percent === "number"
    ? normalizeUsagePercent(usage.percent)
    : tokens !== undefined && contextWindow && contextWindow > 0
      ? Math.max(0, Math.min(1, tokens / contextWindow))
      : undefined;

  if (tokens !== undefined && contextWindow !== undefined) {
    return `${theme.fg("dim", "ctx")} ${colorUsagePercent(theme, fraction ?? 0)} ${theme.fg("dim", `${compactTokenCount(tokens)}/${compactTokenCount(contextWindow)}`)}`;
  }

  if (contextWindow !== undefined) {
    return `${theme.fg("dim", "ctx")} ${theme.fg("dim", "···")} ${theme.fg("dim", compactTokenCount(contextWindow))}`;
  }

  return `${theme.fg("dim", "ctx")} ${theme.fg("dim", "···")}`;
}

function isUsingSubscription(ctx: any): boolean | undefined {
  if (!ctx.model || typeof ctx.modelRegistry?.isUsingOAuth !== "function") return undefined;
  return Boolean(ctx.modelRegistry.isUsingOAuth(ctx.model));
}

function formatAuth(ctx: any, theme: any): string {
  const usingSub = isUsingSubscription(ctx);
  if (usingSub === undefined) {
    return `${theme.fg("dim", "sub")}/${theme.fg("error", "API")}`;
  }
  if (usingSub) {
    return `${theme.fg("success", theme.bold("SUB"))}/${theme.fg("dim", "api")}`;
  }
  return `${theme.fg("dim", "sub")}/${theme.fg("error", theme.bold("API"))}`;
}

function formatAuthCompact(ctx: any, theme: any): string {
  const usingSub = isUsingSubscription(ctx);
  if (usingSub === undefined) return theme.fg("dim", "api");
  return usingSub ? theme.fg("success", "sub") : theme.fg("warning", "api");
}

function formatProfileCompact(profile: ProfileMode, theme: any): string {
  return profile === "work" ? theme.fg("muted", "work") : theme.fg("dim", "personal");
}

function thinkingLevelToStrength(level: string): number {
  switch (level as ThinkingLevel) {
    case "minimal": return 1;
    case "low": return 1;
    case "medium": return 2;
    case "high": return 3;
    case "xhigh": return 4;
    default: return 0;
  }
}

function formatThinkingMeter(level: string, theme: any): string {
  const strength = thinkingLevelToStrength(level);
  const empty = theme.fg("dim", "□");
  const filledColor = strength >= 4 ? "warning" : "muted";
  const filled = theme.fg(filledColor, "■");

  if (strength <= 0) return `${empty}${empty}${empty}${empty}`;
  if (strength === 1) return `${empty}${empty}${empty}${filled}`;
  if (strength === 2) return `${empty}${empty}${filled}${filled}`;
  if (strength === 3) return `${empty}${filled}${filled}${filled}`;
  return `${filled}${filled}${filled}${filled}`;
}

function modelLabel(pi: ExtensionAPI, ctx: any): string {
  const model = ctx.model;
  if (!model) return "none";

  const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
  if (model.reasoning && level && level !== "off") {
    return `${model.id}/${level}`;
  }
  return model.id;
}

function modelLabelCompact(pi: ExtensionAPI, ctx: any, theme: any): string {
  const model = ctx.model;
  if (!model) return "none";

  const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
  const meter = model.reasoning && level && level !== "off" ? formatThinkingMeter(level, theme) : theme.fg("dim", "□□□");
  return `${model.id} ${meter}`;
}

function compactVcsLabel(raw: string | undefined, branch: string | null | undefined): string {
  const text = raw ? sanitizeStatusText(raw) : (branch ?? "none");
  if (text.startsWith("jj ws=")) {
    const match = text.match(/^jj ws=([^ ]+) ch=([^ ]+)$/);
    if (match) return `jj ${match[1]} ${match[2]}`;
  }
  if (text.startsWith("git wt=")) {
    return text
      .replace(/^git wt=/, "git ")
      .replace(/\s+\+0\b/g, "")
      .replace(/\s+~0\b/g, "")
      .replace(/\s+\?0\b/g, "")
      .replace(/\s+!0\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return text;
}

function formatIsoCompact(isoRaw: string | undefined, availRaw: string | undefined, theme: any): string | undefined {
  const running = isoRaw ? Number.parseInt(sanitizeStatusText(isoRaw), 10) : NaN;
  const available = availRaw ? Number.parseInt(sanitizeStatusText(availRaw), 10) : NaN;

  if (!Number.isFinite(running) && !Number.isFinite(available)) return undefined;
  if (Number.isFinite(running) && running <= 0) return undefined;

  const runningText = Number.isFinite(running)
    ? theme.fg(available <= 0 ? "error" : "warning", String(running))
    : theme.fg("dim", "?");

  if (Number.isFinite(running) && Number.isFinite(available)) {
    const total = running + available;
    return `${theme.fg("dim", "iso")} ${runningText}${theme.fg("dim", "/")}${theme.fg("dim", String(total))}`;
  }

  return `${theme.fg("dim", "iso")} ${runningText}`;
}

function renderCompactFooter(pi: ExtensionAPI, ctx: any, theme: any, footerData: any): string {
  const config = loadConfig(ctx.cwd);
  const extensionStatuses = footerData.getExtensionStatuses();
  const branch = footerData.getGitBranch();
  const vcsStatusRaw = extensionStatuses.get("vcs-v2");
  const isoRaw = extensionStatuses.get("iso-v2");
  const availRaw = extensionStatuses.get("avail-v2");

  const vcsText = theme.fg("text", compactVcsLabel(vcsStatusRaw, branch));
  const contextText = formatContextCompact(ctx, theme);
  const isoText = formatIsoCompact(isoRaw, availRaw, theme);
  const modelText = theme.fg("text", modelLabelCompact(pi, ctx, theme));
  const identityText = config.showAuth
    ? `${formatProfileCompact(config.profile, theme)}${theme.fg("dim", "/")}${formatAuthCompact(ctx, theme)}`
    : formatProfileCompact(config.profile, theme);

  const fields = [vcsText, contextText];
  if (isoText) fields.push(isoText);
  fields.push(modelText, identityText);

  return fields.join(theme.fg("dim", " · "));
}

function renderClassicFooter(pi: ExtensionAPI, ctx: any, theme: any, footerData: any): string {
  const config = loadConfig(ctx.cwd);
  const profileText = config.profile === "work" ? theme.fg("warning", "WORK") : theme.fg("accent", "PERSONAL");
  const authText = config.showAuth ? formatAuth(ctx, theme) : theme.fg("dim", "off");
  const modelText = theme.fg("text", modelLabel(pi, ctx));
  const contextText = formatContextPct(ctx, theme);

  const extensionStatuses = footerData.getExtensionStatuses();
  const branch = footerData.getGitBranch();
  const vcsStatusRaw = extensionStatuses.get("vcs-v2");
  const isoRaw = extensionStatuses.get("iso-v2");
  const availRaw = extensionStatuses.get("avail-v2");
  const usageRaw = extensionStatuses.get("usage-tracker");

  const vcsText = vcsStatusRaw
    ? theme.fg("text", sanitizeStatusText(vcsStatusRaw))
    : branch
      ? theme.fg("text", branch)
      : theme.fg("dim", "none");

  const isoCount = isoRaw ? Number.parseInt(sanitizeStatusText(isoRaw), 10) : NaN;
  const isoText = Number.isFinite(isoCount)
    ? isoCount > 0
      ? theme.fg("warning", String(isoCount))
      : theme.fg("dim", "0")
    : undefined;

  const availCount = availRaw ? Number.parseInt(sanitizeStatusText(availRaw), 10) : NaN;
  const availText = Number.isFinite(availCount)
    ? availCount <= 0
      ? theme.fg("error", String(availCount))
      : theme.fg("dim", String(availCount))
    : undefined;

  const dirText = theme.fg("dim", compactPath(ctx.cwd));

  const fields = [
    `PRF:${profileText}`,
    `AUTH:${authText}`,
    `MOD:${modelText}`,
    `CTX:${contextText}`,
    `VCS:${vcsText}`,
  ];

  if (isoText !== undefined) fields.push(`ISO:${isoText}`);
  if (availText !== undefined) fields.push(`AVAIL:${availText}`);

  if (usageRaw) {
    const raw = sanitizeStatusText(usageRaw);
    if (raw.includes(":")) {
      const colored = raw.replace(/(\d+)%/g, (_match, pctStr) => {
        const pct = parseInt(pctStr, 10);
        if (pct >= 80) return theme.fg("error", `${pct}%`);
        if (pct >= 50) return theme.fg("warning", `${pct}%`);
        return theme.fg("success", `${pct}%`);
      });
      fields.push(`USE:${colored}`);
    } else {
      const usageParts = raw.split("/");
      const dayText = usageParts[0] || "?";
      const weekText = usageParts[1] || "?";
      fields.push(`USE:${theme.fg("dim", dayText)}/${theme.fg("dim", weekText)}`);
    }
  }

  fields.push(`DIR:${dirText}`);
  return fields.join(theme.fg("dim", " | "));
}

export default function statusBarV2(pi: ExtensionAPI) {
  const applyFooter = (ctx: any): void => {
    const config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => ({
      invalidate() {},
      render(width: number) {
        const line = config.compactFooter
          ? renderCompactFooter(pi, ctx, theme, footerData)
          : renderClassicFooter(pi, ctx, theme, footerData);
        return [truncateToWidth(line, width)];
      },
      dispose: footerData.onBranchChange(() => tui.requestRender()),
    }));
  };

  pi.on("session_start", async (_event, ctx) => {
    applyFooter(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    applyFooter(ctx);
  });

  pi.registerCommand("statusbar-v2", {
    description: "Configure status bar v2: on|off|personal|work|compact|classic|show",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();

      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        ctx.ui.notify("status-bar-v2 enabled. Run /reload.", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        ctx.ui.notify("status-bar-v2 disabled. Run /reload.", "success");
        return;
      }
      if (cmd === "personal" || cmd === "work") {
        writeGlobalConfig({ profile: cmd });
        ctx.ui.notify(`status-bar-v2 profile set to ${cmd}. Run /reload.`, "success");
        return;
      }
      if (cmd === "compact") {
        writeGlobalConfig({ compactFooter: true });
        ctx.ui.notify("status-bar-v2 compact footer enabled. Run /reload.", "success");
        return;
      }
      if (cmd === "classic") {
        writeGlobalConfig({ compactFooter: false });
        ctx.ui.notify("status-bar-v2 classic footer restored. Run /reload.", "success");
        return;
      }

      const cfg = loadConfig(ctx.cwd);
      ctx.ui.notify(
        `status-bar-v2 enabled=${cfg.enabled} profile=${cfg.profile} showAuth=${cfg.showAuth} compactFooter=${cfg.compactFooter}`,
        "info",
      );
    },
  });
}
