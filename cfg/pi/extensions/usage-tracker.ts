/**
 * Usage Tracker Extension
 *
 * Intercepts Anthropic API response headers to capture real subscription
 * rate limit utilization (anthropic-ratelimit-unified-*).
 *
 * Also tracks cumulative token usage per day/week as a fallback for
 * non-Anthropic providers.
 *
 * Status bar shows: "5h:23% 7d:45%" for sub models, or "D:1.2M/W:8.5M" for API.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface RateLimitWindow {
  status: string;         // "allowed" | "exceeded" | "rate_limited"
  utilization: number;    // 0.0 - 1.0
  reset?: number;         // unix timestamp
}

interface RateLimitState {
  /** Last update timestamp */
  timestamp: number;
  /** Per-window utilization from headers */
  windows: Record<string, RateLimitWindow>; // "5h", "7d", "7d_sonnet", etc.
  /** Top-level status */
  status?: string;
  /** Which window is the binding constraint */
  representativeClaim?: string;
  /** Fallback percentage */
  fallbackPercentage?: number;
}

interface OpenAIRateLimitState {
  timestamp: number;
  remainingRequests: number;
  limitRequests: number;
  remainingTokens: number;
  limitTokens: number;
  resetRequests?: string;
  resetTokens?: string;
}

interface DayEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  cost: number;
}

interface UsageLog {
  days: Record<string, DayEntry>;
}

// ============================================================================
// Globals — shared between fetch interceptor and extension
// ============================================================================

let latestRateLimits: RateLimitState | null = null;
let latestOpenAILimits: OpenAIRateLimitState | null = null;
let fetchPatched = false;

// ============================================================================
// Fetch interceptor
// ============================================================================

function patchFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const response = await originalFetch.call(globalThis, input, init);

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url) {
      try {
        if (url.includes("anthropic.com")) {
          extractAnthropicRateLimits(response.headers);
        } else if (url.includes("openai.com") || url.includes("api.chatgpt.com")) {
          extractOpenAIRateLimits(response.headers);
        }
      } catch {
        // Never break the actual API call
      }
    }

    return response;
  };
}

function extractAnthropicRateLimits(headers: Headers): void {
  // Look for anthropic-ratelimit-unified-* headers
  const prefix = "anthropic-ratelimit-unified-";
  const windowPattern = /^anthropic-ratelimit-unified-(\w+)-(status|utilization|reset|surpassed-threshold)$/;

  const windows: Record<string, RateLimitWindow> = {};
  let hasAny = false;

  // Headers.forEach is the standard way to iterate
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();

    if (!lower.startsWith(prefix)) return;
    hasAny = true;

    const match = lower.match(windowPattern);
    if (match) {
      const [, windowName, field] = match;
      if (!windows[windowName]) {
        windows[windowName] = { status: "unknown", utilization: 0 };
      }
      if (field === "status") {
        windows[windowName].status = value;
      } else if (field === "utilization") {
        windows[windowName].utilization = parseFloat(value) || 0;
      } else if (field === "reset") {
        windows[windowName].reset = parseInt(value, 10) || undefined;
      }
    }
  });

  if (!hasAny) return;

  // Extract top-level fields
  const status = headers.get(`${prefix}status`) || undefined;
  const representativeClaim = headers.get(`${prefix}representative-claim`) || undefined;
  const fallbackPct = headers.get(`${prefix}fallback-percentage`);

  latestRateLimits = {
    timestamp: Date.now(),
    windows,
    status,
    representativeClaim,
    fallbackPercentage: fallbackPct ? parseFloat(fallbackPct) : undefined,
  };
}

function extractOpenAIRateLimits(headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining-requests");
  const limit = headers.get("x-ratelimit-limit-requests");
  const remainingTokens = headers.get("x-ratelimit-remaining-tokens");
  const limitTokens = headers.get("x-ratelimit-limit-tokens");

  // Skip if no valid data (some endpoints return -1)
  if (!remaining && !remainingTokens) return;
  if (remaining === "-1" && remainingTokens === "-1") return;

  latestOpenAILimits = {
    timestamp: Date.now(),
    remainingRequests: parseInt(remaining || "0", 10),
    limitRequests: parseInt(limit || "0", 10),
    remainingTokens: parseInt(remainingTokens || "0", 10),
    limitTokens: parseInt(limitTokens || "0", 10),
    resetRequests: headers.get("x-ratelimit-reset-requests") || undefined,
    resetTokens: headers.get("x-ratelimit-reset-tokens") || undefined,
  };
}

// ============================================================================
// Persistence (cumulative token tracking as fallback)
// ============================================================================

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getLogPath(): string {
  return path.join(getAgentDir(), "usage-log.json");
}

function loadLog(): UsageLog {
  try {
    const raw = fs.readFileSync(getLogPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.days) return parsed as UsageLog;
  } catch {}
  return { days: {} };
}

function saveLog(log: UsageLog): void {
  // Prune entries older than 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = dateStr(cutoff);

  const pruned: Record<string, DayEntry> = {};
  for (const [day, entry] of Object.entries(log.days)) {
    if (day >= cutoffStr) pruned[day] = entry;
  }

  fs.writeFileSync(getLogPath(), JSON.stringify({ days: pruned }, null, 2) + "\n", "utf8");
}

// ============================================================================
// Helpers
// ============================================================================

function dateStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function getWeekDates(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(dateStr(d));
  }
  return dates;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `${(n * 100).toFixed(1)}¢`;
  return `${(n * 100).toFixed(2)}¢`;
}

function formatTimeUntil(resetTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = resetTimestamp - now;
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

function sumEntries(entries: DayEntry[]): DayEntry {
  return entries.reduce(
    (acc, e) => ({
      input: acc.input + e.input,
      output: acc.output + e.output,
      cacheRead: acc.cacheRead + e.cacheRead,
      cacheWrite: acc.cacheWrite + e.cacheWrite,
      requests: acc.requests + e.requests,
      cost: acc.cost + e.cost,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 },
  );
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ============================================================================
// Status formatting
// ============================================================================

function formatRateLimitStatus(): string | null {
  // Try Anthropic unified rate limits first
  if (latestRateLimits && Date.now() - latestRateLimits.timestamp < 10 * 60 * 1000) {
    const parts: string[] = [];
    const w = latestRateLimits.windows;

    if (w["5h"]) {
      const pct = Math.round(w["5h"].utilization * 100);
      const reset = w["5h"].reset ? ` ↻${formatTimeUntil(w["5h"].reset)}` : "";
      parts.push(`5h:${pct}%${reset}`);
    }
    if (w["7d"]) {
      const pct = Math.round(w["7d"].utilization * 100);
      parts.push(`7d:${pct}%`);
    }
    if (w["7d_sonnet"] && !w["7d"]) {
      const pct = Math.round(w["7d_sonnet"].utilization * 100);
      parts.push(`7d:${pct}%`);
    }

    if (parts.length > 0) return parts.join(" ");
  }

  // Try OpenAI/Codex per-minute rate limits
  if (latestOpenAILimits && Date.now() - latestOpenAILimits.timestamp < 10 * 60 * 1000) {
    const rl = latestOpenAILimits;
    const parts: string[] = [];

    if (rl.limitRequests > 0) {
      const pct = Math.round((1 - rl.remainingRequests / rl.limitRequests) * 100);
      parts.push(`RPM:${pct}%`);
    }
    if (rl.limitTokens > 0) {
      const pct = Math.round((1 - rl.remainingTokens / rl.limitTokens) * 100);
      parts.push(`TPM:${pct}%`);
    }

    if (parts.length > 0) return parts.join(" ");
  }

  return null;
}

function formatCumulativeStatus(log: UsageLog): string {
  const today = dateStr();
  const todayEntry = log.days[today] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 };
  const todayTotal = todayEntry.input + todayEntry.output;

  const weekEntries = getWeekDates().map((d) => log.days[d]).filter((e): e is DayEntry => !!e);
  const weekTotal = sumEntries(weekEntries);
  const weekTotalTokens = weekTotal.input + weekTotal.output;

  return `${formatTokens(todayTotal)}/${formatTokens(weekTotalTokens)}`;
}

// ============================================================================
// Extension
// ============================================================================

export default function usageTracker(pi: ExtensionAPI) {
  // Patch fetch immediately to start capturing headers
  patchFetch();

  let log = loadLog();

  function recordUsage(message: any): void {
    if (!message || message.role !== "assistant" || !message.usage) return;

    const usage = message.usage;
    const today = dateStr();

    if (!log.days[today]) {
      log.days[today] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 };
    }

    const entry = log.days[today];
    entry.input += usage.input || 0;
    entry.output += usage.output || 0;
    entry.cacheRead += usage.cacheRead || 0;
    entry.cacheWrite += usage.cacheWrite || 0;
    entry.requests += 1;
    entry.cost += usage.cost?.total || 0;

    saveLog(log);
  }

  function updateStatus(ctx: any): void {
    // Prefer real rate limit data from headers
    const rlStatus = formatRateLimitStatus();
    if (rlStatus) {
      ctx.ui.setStatus("usage-tracker", rlStatus);
      return;
    }

    // Fallback: cumulative tracking
    ctx.ui.setStatus("usage-tracker", formatCumulativeStatus(log));
  }

  // Track usage from every assistant message
  pi.on("turn_end", (event, ctx) => {
    recordUsage(event.message);
    updateStatus(ctx);
  });

  // Set initial status on session start
  pi.on("session_start", (_event, ctx) => {
    log = loadLog();
    updateStatus(ctx);
  });

  // /usage command for detailed breakdown
  pi.registerCommand("usage", {
    description: "Show token usage and rate limit status",
    handler: async (_args, ctx) => {
      log = loadLog();
      const today = dateStr();
      const todayEntry = log.days[today] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 };

      const weekDates = getWeekDates();
      const weekEntries = weekDates.map((d) => log.days[d]).filter((e): e is DayEntry => !!e);
      const weekSum = sumEntries(weekEntries);

      const lines = [
        `── Usage & Rate Limits ──`,
        ``,
      ];

      // Anthropic rate limit data
      if (latestRateLimits && Date.now() - latestRateLimits.timestamp < 10 * 60 * 1000) {
        lines.push(`Anthropic Subscription Limits:`);
        for (const [name, w] of Object.entries(latestRateLimits.windows)) {
          const pct = (w.utilization * 100).toFixed(1);
          const reset = w.reset ? ` (resets in ${formatTimeUntil(w.reset)})` : "";
          const status = w.status !== "allowed" ? ` [${w.status}]` : "";
          lines.push(`  ${name}: ${pct}% used${reset}${status}`);
        }
        if (latestRateLimits.representativeClaim) {
          lines.push(`  Binding constraint: ${latestRateLimits.representativeClaim}`);
        }
        lines.push(``);
      }

      // OpenAI/Codex rate limit data
      if (latestOpenAILimits && Date.now() - latestOpenAILimits.timestamp < 10 * 60 * 1000) {
        const rl = latestOpenAILimits;
        lines.push(`OpenAI/Codex Rate Limits (per-minute):`);
        if (rl.limitRequests > 0) {
          lines.push(`  Requests: ${rl.remainingRequests}/${rl.limitRequests} remaining${rl.resetRequests ? ` (resets in ${rl.resetRequests})` : ""}`);
        }
        if (rl.limitTokens > 0) {
          lines.push(`  Tokens: ${formatTokens(rl.remainingTokens)}/${formatTokens(rl.limitTokens)} remaining${rl.resetTokens ? ` (resets in ${rl.resetTokens})` : ""}`);
        }
        lines.push(``);
      }

      if (!latestRateLimits && !latestOpenAILimits) {
        lines.push(`Rate Limits: No data yet (will appear after first API call)`);
        lines.push(``);
      }

      lines.push(
        `Token Usage Today (${today}):`,
        `  Input:       ${formatTokens(todayEntry.input)}`,
        `  Output:      ${formatTokens(todayEntry.output)}`,
        `  Cache Read:  ${formatTokens(todayEntry.cacheRead)}`,
        `  Cache Write: ${formatTokens(todayEntry.cacheWrite)}`,
        `  Total:       ${formatTokens(todayEntry.input + todayEntry.output)}`,
        `  Requests:    ${todayEntry.requests}`,
        `  Cost:        ${formatCost(todayEntry.cost)}`,
        ``,
        `This Week (7 days):`,
        `  Input:       ${formatTokens(weekSum.input)}`,
        `  Output:      ${formatTokens(weekSum.output)}`,
        `  Cache Read:  ${formatTokens(weekSum.cacheRead)}`,
        `  Total:       ${formatTokens(weekSum.input + weekSum.output)}`,
        `  Requests:    ${weekSum.requests}`,
        `  Cost:        ${formatCost(weekSum.cost)}`,
        ``,
        `Daily breakdown:`,
      );

      for (const d of weekDates) {
        const e = log.days[d];
        if (e) {
          const total = e.input + e.output;
          lines.push(`  ${d}: ${formatTokens(total)} (${e.requests} reqs, ${formatCost(e.cost)})`);
        } else {
          lines.push(`  ${d}: —`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
