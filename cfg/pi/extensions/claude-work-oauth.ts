import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loginAnthropic, refreshAnthropicToken } from "@mariozechner/pi-ai/oauth";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";

const PROVIDER_ID = "claude-work";
const SETTINGS_PATH = join(os.homedir(), ".pi/agent/settings.json");

const MODELS = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 [WORK]",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 [WORK]",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
];

type GlobalSettings = {
  claudeWorkOauth?: {
    enabled?: boolean;
  };
  [key: string]: unknown;
};

async function readSettings(): Promise<GlobalSettings> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as GlobalSettings;
  } catch {
    return {};
  }
}

async function writeSettings(next: GlobalSettings): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function setEnabled(enabled: boolean): Promise<void> {
  const settings = await readSettings();
  settings.claudeWorkOauth = { ...(settings.claudeWorkOauth ?? {}), enabled };
  await writeSettings(settings);
}

async function isEnabled(): Promise<boolean> {
  const settings = await readSettings();
  return settings.claudeWorkOauth?.enabled === true;
}

function registerClaudeWorkProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: MODELS,
    oauth: {
      name: "Claude Work (Anthropic OAuth)",
      async login(callbacks) {
        callbacks.onProgress?.("Sign in with your work Anthropic account in the browser.");
        return loginAnthropic({
          onAuth: callbacks.onAuth,
          onPrompt: callbacks.onPrompt,
          onProgress: callbacks.onProgress,
          onManualCodeInput: callbacks.onManualCodeInput,
          signal: callbacks.signal,
        });
      },
      async refreshToken(credentials) {
        const refreshed = await refreshAnthropicToken(credentials.refresh);
        return { ...credentials, ...refreshed };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
}

async function formatStatus(ctx: ExtensionCommandContext): Promise<string> {
  const enabled = await isEnabled();
  const auth = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
  const loggedIn = auth?.type === "oauth";
  const expires = loggedIn && typeof auth.expires === "number"
    ? new Date(auth.expires).toISOString()
    : "n/a";
  return `Claude Work OAuth: ${enabled ? "on" : "off"} · auth: ${loggedIn ? "present" : "missing"} · expires: ${expires}`;
}

export default function (pi: ExtensionAPI) {
  let registered = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!(await isEnabled())) return;
    if (!registered) {
      registerClaudeWorkProvider(pi);
      registered = true;
    }
    const auth = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
    if (!auth && ctx.hasUI) {
      ctx.ui.notify("Claude Work OAuth is enabled. Run /login claude-work and sign in with your work Anthropic account.", "info");
    }
  });

  pi.registerCommand("claude-work-oauth", {
    description: "Enable/disable Claude Work OAuth provider (on|off|status)",
    handler: async (args, ctx) => {
      const command = (args || "status").trim().toLowerCase();
      if (command === "status" || command === "") {
        ctx.ui.notify(await formatStatus(ctx), "info");
        return;
      }
      if (command === "on") {
        await setEnabled(true);
        ctx.ui.notify("Claude Work OAuth enabled. Reloading...", "success");
        await ctx.reload();
        return;
      }
      if (command === "off") {
        pi.unregisterProvider(PROVIDER_ID);
        await setEnabled(false);
        ctx.ui.notify("Claude Work OAuth disabled. Reloading...", "warning");
        await ctx.reload();
        return;
      }
      ctx.ui.notify("Usage: /claude-work-oauth on|off|status", "error");
    },
  });
}
