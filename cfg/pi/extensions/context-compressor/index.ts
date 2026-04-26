import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CompressionSettings = {
  enabled: boolean;
  warnThreshold: number;
  compressThreshold: number;
  keepLastTurns: number;
  searchTerms: string[];
  customInstructions?: string;
};

const DEFAULT_SETTINGS: CompressionSettings = {
  enabled: true,
  warnThreshold: 160000,
  compressThreshold: 190000,
  keepLastTurns: 10,
  searchTerms: ["decision", "agreed", "error", "bug", "fix", "important", "conclusion", "plan"],
  customInstructions:
    "Focus on decisions made, files modified, errors encountered and resolved, and the current direction of work.",
};

type ContextState = {
  warned: boolean;
  lastCompressedAt: number;
};

const contextState = new Map<string, ContextState>();

export default function contextCompressor(pi: ExtensionAPI) {
  pi.on("turn_end", (_event, ctx) => {
    const settings = getSettings(pi.settings);
    if (!settings.enabled) return;

    const usage = ctx.getContextUsage();
    const currentTokens = usage?.tokens ?? null;
    if (currentTokens === null) return;

    const sessionId = getSessionId(pi);
    if (!sessionId) return;

    const state = contextState.get(sessionId) ?? { warned: false, lastCompressedAt: 0 };

    if (currentTokens >= settings.compressThreshold) {
      const now = Date.now();
      if (now - state.lastCompressedAt < 300000) return;

      state.lastCompressedAt = now;
      state.warned = false;
      contextState.set(sessionId, state);

      void buildInstructions(sessionId, settings).then((customInstructions) => {
        ctx.ui.notify("Context compressor: triggering recall-informed compaction", "info");
        ctx.compact({
          customInstructions,
          onComplete: (result) => {
            ctx.ui.notify(
              `Context compressed: ${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()} tokens`,
              "success",
            );
          },
          onError: (error) => {
            ctx.ui.notify(`Context compression failed: ${error.message}`, "error");
          },
        });
      });
    } else if (currentTokens >= settings.warnThreshold && !state.warned) {
      state.warned = true;
      contextState.set(sessionId, state);
      ctx.ui.notify(
        `Context compressor: ${currentTokens.toLocaleString()}/${settings.compressThreshold.toLocaleString()} tokens`,
        "warning",
      );
    } else if (currentTokens < settings.warnThreshold && state.warned) {
      state.warned = false;
      contextState.set(sessionId, state);
    }
  });

  pi.registerCommand("compression-status", {
    description: "Show context compression settings/status",
    handler: async (_args, ctx) => {
      const settings = getSettings(pi.settings);
      const usage = ctx.getContextUsage();
      ctx.ui.notify(
        `compression enabled=${settings.enabled} tokens=${usage?.tokens ?? "unknown"} warn=${settings.warnThreshold} compact=${settings.compressThreshold}`,
        "info",
      );
    },
  });
}

async function buildInstructions(sessionId: string, settings: CompressionSettings): Promise<string> {
  const searchResults = await searchRecall(sessionId, settings.searchTerms);
  if (!searchResults.trim()) return settings.customInstructions ?? DEFAULT_SETTINGS.customInstructions!;
  return `${settings.customInstructions ?? DEFAULT_SETTINGS.customInstructions}\n\n## Key Information from Recall Search\n\n${searchResults}`;
}

async function searchRecall(sessionId: string, searchTerms: string[]): Promise<string> {
  const allResults: string[] = [];

  for (const term of searchTerms) {
    try {
      const { stdout } = await execFileAsync("recall", ["search", term, "--session-id", sessionId, "--compact", "--context", "1", "--limit", "20"], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });

      if (stdout.trim()) allResults.push(`## Matches for "${term}"\n${stdout.trim()}`);
    } catch {
      // recall is optional; missing/empty search results should not block compaction.
    }
  }

  return allResults.join("\n\n---\n\n");
}

function getSettings(settings: unknown): CompressionSettings {
  const root = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const userSettings = root.compression && typeof root.compression === "object" ? (root.compression as Partial<CompressionSettings>) : {};
  return { ...DEFAULT_SETTINGS, ...userSettings };
}

function getSessionId(pi: ExtensionAPI): string | undefined {
  const maybePi = pi as unknown as { session?: { sessionId?: string } };
  return maybePi.session?.sessionId;
}
