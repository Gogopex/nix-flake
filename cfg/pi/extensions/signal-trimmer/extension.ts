import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SignalTrimmerConfig {
  enabled: boolean;
  keepRecentTurns: number;
  summaryMaxChars: number;
  bashErrorLines: number;
  bashHeadLines: number;
  bashTailLines: number;
  deduplicateReads: boolean;
  deduplicateBashOutputs: boolean;
  stripOldThinking: boolean;
  warnPercent: number;
  compactPercent: number;
  minTurnsBetweenAutoCompact: number;
  autoCompact: boolean;
  showStatusLine: boolean;
  showAutoCompactMessage: boolean;
  debug: boolean;
}

const DEFAULT_CONFIG: SignalTrimmerConfig = {
  enabled: false,
  keepRecentTurns: 12,
  summaryMaxChars: 280,
  bashErrorLines: 5,
  bashHeadLines: 3,
  bashTailLines: 5,
  deduplicateReads: true,
  deduplicateBashOutputs: true,
  stripOldThinking: false,
  warnPercent: 0.75,
  compactPercent: 0.9,
  minTurnsBetweenAutoCompact: 3,
  autoCompact: false,
  showStatusLine: true,
  showAutoCompactMessage: false,
  debug: false,
};

interface Turn {
  startIndex: number;
  endIndex: number;
}

interface SessionState {
  warned: boolean;
  turnsSinceAutoCompact: number;
}

interface ToolCallMetadata {
  readPathByCallId: Map<string, string>;
  bashCommandByCallId: Map<string, string>;
}

const sessionState = new Map<string, SessionState>();

export default function signalTrimmer(pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;

    const trimmed = trimMessages(event.messages, config);

    const originalChars = event.messages.reduce((sum, message) => sum + estimateMessageChars(message as Message), 0);
    const trimmedChars = trimmed.reduce((sum, message) => sum + estimateMessageChars(message as Message), 0);
    const saved = Math.max(0, originalChars - trimmedChars);
    const savedPercent = originalChars > 0 ? ((saved / originalChars) * 100).toFixed(1) : "0.0";

    if (config.debug) {
      ctx.ui.setStatus("signal-trimmer", `trim ${savedPercent}% (${saved.toLocaleString()} chars)`);
    }

    return { messages: trimmed };
  });

  pi.on("turn_end", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;

    const usage = ctx.getContextUsage();
    if (usage?.percent == null) return;

    const sessionKey = ctx.cwd;
    const state = sessionState.get(sessionKey) ?? { warned: false, turnsSinceAutoCompact: Number.MAX_SAFE_INTEGER };
    const usageFraction = normalizeUsagePercent(usage.percent);
    const percent = Math.round(usageFraction * 100);

    if (config.showStatusLine) {
      const mode = config.autoCompact ? `auto@${Math.round(config.compactPercent * 100)}%` : "warn-only";
      ctx.ui.setStatus("signal-trimmer-pressure", `ctx ${percent}% · ${mode}`);
    }

    if (usageFraction >= config.warnPercent && !state.warned) {
      state.warned = true;
      ctx.ui.notify(`signal-trimmer: context at ${percent}% of window`, "warning");
    }

    if (usageFraction < config.warnPercent) {
      state.warned = false;
    }

    state.turnsSinceAutoCompact += 1;

    if (
      config.autoCompact &&
      usageFraction >= config.compactPercent &&
      state.turnsSinceAutoCompact >= config.minTurnsBetweenAutoCompact
    ) {
      state.turnsSinceAutoCompact = 0;
      ctx.ui.notify(`signal-trimmer: auto-compacting at ${percent}% context usage`, "warning");
      if (config.showAutoCompactMessage) {
        pi.sendMessage({
          customType: "signal-trimmer",
          content: `signal-trimmer auto-compaction triggered at ${percent}% context usage`,
          display: true,
          details: {
            kind: "auto-compact",
            percent,
            thresholdPercent: Math.round(config.compactPercent * 100),
          },
        });
      }
      await ctx.compact();
    }

    sessionState.set(sessionKey, state);
  });
}

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

function loadConfig(cwd: string): SignalTrimmerConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.signalTrimmer && typeof global.signalTrimmer === "object"
    ? global.signalTrimmer
    : {}) as Record<string, unknown>;
  const p = (project.signalTrimmer && typeof project.signalTrimmer === "object"
    ? project.signalTrimmer
    : {}) as Record<string, unknown>;

  return {
    enabled: pick(p.enabled, g.enabled, DEFAULT_CONFIG.enabled),
    keepRecentTurns: pick(p.keepRecentTurns, g.keepRecentTurns, DEFAULT_CONFIG.keepRecentTurns),
    summaryMaxChars: pick(p.summaryMaxChars, g.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars),
    bashErrorLines: pick(p.bashErrorLines, g.bashErrorLines, DEFAULT_CONFIG.bashErrorLines),
    bashHeadLines: pick(p.bashHeadLines, g.bashHeadLines, DEFAULT_CONFIG.bashHeadLines),
    bashTailLines: pick(p.bashTailLines, g.bashTailLines, DEFAULT_CONFIG.bashTailLines),
    deduplicateReads: pick(p.deduplicateReads, g.deduplicateReads, DEFAULT_CONFIG.deduplicateReads),
    deduplicateBashOutputs: pick(
      p.deduplicateBashOutputs,
      g.deduplicateBashOutputs,
      DEFAULT_CONFIG.deduplicateBashOutputs,
    ),
    stripOldThinking: pick(p.stripOldThinking, g.stripOldThinking, DEFAULT_CONFIG.stripOldThinking),
    warnPercent: pick(p.warnPercent, g.warnPercent, DEFAULT_CONFIG.warnPercent),
    compactPercent: pick(p.compactPercent, g.compactPercent, DEFAULT_CONFIG.compactPercent),
    minTurnsBetweenAutoCompact: pick(
      p.minTurnsBetweenAutoCompact,
      g.minTurnsBetweenAutoCompact,
      DEFAULT_CONFIG.minTurnsBetweenAutoCompact,
    ),
    autoCompact: pick(p.autoCompact, g.autoCompact, DEFAULT_CONFIG.autoCompact),
    showStatusLine: pick(p.showStatusLine, g.showStatusLine, DEFAULT_CONFIG.showStatusLine),
    showAutoCompactMessage: pick(
      p.showAutoCompactMessage,
      g.showAutoCompactMessage,
      DEFAULT_CONFIG.showAutoCompactMessage,
    ),
    debug: pick(p.debug, g.debug, DEFAULT_CONFIG.debug),
  };
}

function pick<T>(project: unknown, global: unknown, fallback: T): T {
  if (project !== undefined && typeof project === typeof fallback) return project as T;
  if (global !== undefined && typeof global === typeof fallback) return global as T;
  return fallback;
}

function identifyTurns(messages: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentStart = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Message;
    if (msg.role === "user") {
      if (currentStart >= 0) turns.push({ startIndex: currentStart, endIndex: i - 1 });
      currentStart = i;
    }
  }

  if (currentStart >= 0) turns.push({ startIndex: currentStart, endIndex: messages.length - 1 });
  return turns;
}

function trimMessages(messages: AgentMessage[], config: SignalTrimmerConfig): AgentMessage[] {
  if (messages.length === 0) return messages;

  const turns = identifyTurns(messages);
  if (turns.length <= config.keepRecentTurns) return messages;

  const trimBoundary = turns[turns.length - config.keepRecentTurns].startIndex;
  const metadata = collectToolCallMetadata(messages);
  const latestReadByPath = config.deduplicateReads ? buildLatestReadByPath(messages, metadata.readPathByCallId) : null;
  const latestBashByFingerprint = config.deduplicateBashOutputs
    ? buildLatestBashByFingerprint(messages, metadata.bashCommandByCallId)
    : null;

  return messages.map((raw, index) => {
    const msg = raw as Message;
    if (index >= trimBoundary) return raw;

    if (msg.role === "toolResult") {
      return trimToolResult(msg, index, config, metadata, latestReadByPath, latestBashByFingerprint);
    }

    if (msg.role === "assistant" && config.stripOldThinking) {
      return stripThinking(msg);
    }

    return raw;
  });
}

function collectToolCallMetadata(messages: AgentMessage[]): ToolCallMetadata {
  const readPathByCallId = new Map<string, string>();
  const bashCommandByCallId = new Map<string, string>();

  for (const raw of messages) {
    const msg = raw as Message;
    if (msg.role !== "assistant") continue;

    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;
      const toolName = block.name.toLowerCase();
      if (toolName === "read") {
        const maybePath = (block.arguments as { path?: string } | undefined)?.path;
        if (maybePath) readPathByCallId.set(block.id, maybePath);
      }
      if (toolName === "bash") {
        const maybeCommand = (block.arguments as { command?: string } | undefined)?.command;
        if (maybeCommand) bashCommandByCallId.set(block.id, maybeCommand);
      }
    }
  }

  return { readPathByCallId, bashCommandByCallId };
}

function buildLatestReadByPath(messages: AgentMessage[], readPathByCallId: Map<string, string>): Map<string, number> {
  const latestReadIndex = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index] as Message;
    if (msg.role === "toolResult" && msg.toolName?.toLowerCase() === "read") {
      const filePath = readPathByCallId.get(msg.toolCallId);
      if (filePath) latestReadIndex.set(filePath, index);
    }
  }
  return latestReadIndex;
}

function buildLatestBashByFingerprint(
  messages: AgentMessage[],
  bashCommandByCallId: Map<string, string>,
): Map<string, number> {
  const latestBashIndex = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index] as Message;
    if (msg.role !== "toolResult" || msg.toolName?.toLowerCase() !== "bash") continue;
    const fingerprint = getBashFingerprint(msg, bashCommandByCallId);
    if (fingerprint) latestBashIndex.set(fingerprint, index);
  }
  return latestBashIndex;
}

function getBashFingerprint(
  toolResult: ToolResultMessage,
  bashCommandByCallId: Map<string, string>,
): string | undefined {
  const command = bashCommandByCallId.get(toolResult.toolCallId) ?? "";
  const output = normalizeWhitespace(getTextContent(toolResult));
  if (!command && !output) return undefined;
  return `${command}::${output}`;
}

function trimToolResult(
  toolResult: ToolResultMessage,
  index: number,
  config: SignalTrimmerConfig,
  metadata: ToolCallMetadata,
  latestReadByPath: Map<string, number> | null,
  latestBashByFingerprint: Map<string, number> | null,
): ToolResultMessage {
  const toolName = toolResult.toolName?.toLowerCase() ?? "";

  if (toolName === "read") {
    const filePath = metadata.readPathByCallId.get(toolResult.toolCallId);
    if (filePath && latestReadByPath) {
      const latestIndex = latestReadByPath.get(filePath);
      if (latestIndex !== undefined && latestIndex !== index) {
        return cloneToolResult(toolResult, `[read: ${filePath} — superseded by a later read]`);
      }
    }
    return cloneToolResult(toolResult, summarizeReadResult(toolResult, filePath));
  }

  if (toolName === "bash") {
    const command = metadata.bashCommandByCallId.get(toolResult.toolCallId);
    const fingerprint = latestBashByFingerprint ? getBashFingerprint(toolResult, metadata.bashCommandByCallId) : undefined;
    if (fingerprint && latestBashByFingerprint) {
      const latestIndex = latestBashByFingerprint.get(fingerprint);
      if (latestIndex !== undefined && latestIndex !== index) {
        const label = command ? ` ${shortenInline(command, config.summaryMaxChars / 2)}` : "";
        return cloneToolResult(toolResult, `[bash:${label} — same output as a later bash result]`);
      }
    }
    return cloneToolResult(toolResult, summarizeBashResult(toolResult, config, command));
  }

  if (toolName === "edit") return cloneToolResult(toolResult, summarizeEditResult(toolResult));
  if (toolName === "write") return cloneToolResult(toolResult, summarizeWriteResult(toolResult));
  return cloneToolResult(toolResult, summarizeGenericResult(toolResult, config));
}

function cloneToolResult(toolResult: ToolResultMessage, text: string): ToolResultMessage {
  return {
    ...toolResult,
    content: [{ type: "text", text }],
  };
}

function summarizeReadResult(toolResult: ToolResultMessage, filePath?: string): string {
  const textContent = getTextContent(toolResult);
  const hasImage = toolResult.content.some((content) => content.type === "image");
  const target = filePath ?? "unknown path";
  if (hasImage) return `[read: ${target} — image content omitted, re-read if needed]`;

  const lineCount = textContent.length > 0 ? textContent.split("\n").length : 0;
  const truncated = textContent.includes("more lines in file") || textContent.includes("Use offset=");
  const truncation = truncated ? ", truncated" : "";
  return `[read: ${target} (${lineCount} lines${truncation}) — content omitted, re-read if needed]`;
}

function summarizeBashResult(
  toolResult: ToolResultMessage,
  config: SignalTrimmerConfig,
  command?: string,
): string {
  const textContent = getTextContent(toolResult);
  const lines = textContent.length > 0 ? textContent.split("\n") : [];
  const head = lines.slice(0, config.bashHeadLines).filter(Boolean);
  const tail = config.bashTailLines > 0 ? lines.slice(-config.bashTailLines).filter(Boolean) : [];
  const relevant = lines.filter((line) => /error|failed|exception|panic|fatal/i.test(line) && line.trim().length > 0);
  const keptErrors = relevant.slice(0, config.bashErrorLines);

  const sections: string[] = [];
  if (command) sections.push(`command: ${command}`);
  sections.push(`status: ${toolResult.isError ? "ERROR" : "ok"}`);
  sections.push(`lines: ${lines.length}`);
  if (head.length > 0) sections.push(`head:\n${head.join("\n")}`);
  if (tail.length > 0 && tail.join("\n") !== head.join("\n")) sections.push(`tail:\n${tail.join("\n")}`);
  if (keptErrors.length > 0) sections.push(`key error lines:\n${keptErrors.join("\n")}`);

  return `[bash]\n${sections.join("\n\n")}`;
}

function summarizeEditResult(toolResult: ToolResultMessage): string {
  const textContent = getTextContent(toolResult);
  if (toolResult.isError) return `[edit: FAILED — ${textContent.slice(0, 200)}]`;
  return "[edit: applied successfully — details omitted]";
}

function summarizeWriteResult(toolResult: ToolResultMessage): string {
  const textContent = getTextContent(toolResult);
  if (toolResult.isError) return `[write: FAILED — ${textContent.slice(0, 200)}]`;
  return "[write: success — details omitted]";
}

function summarizeGenericResult(toolResult: ToolResultMessage, config: SignalTrimmerConfig): string {
  const textContent = normalizeWhitespace(getTextContent(toolResult));
  const snippet = textContent.slice(0, config.summaryMaxChars);
  const suffix = textContent.length > config.summaryMaxChars ? "…" : "";
  return `[${toolResult.toolName ?? "tool"}: ${snippet}${suffix}]`;
}

function getTextContent(toolResult: ToolResultMessage): string {
  return toolResult.content
    .filter((content): content is TextContent => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shortenInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function stripThinking(message: AssistantMessage): AssistantMessage {
  const filtered = message.content.filter((content) => content.type !== "thinking");
  return filtered.length === message.content.length ? message : { ...message, content: filtered };
}

function estimateMessageChars(message: unknown): number {
  if (!message || typeof message !== "object") return 0;

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  return content.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    const block = item as { type?: string; text?: string; arguments?: unknown; name?: string };
    if ((block.type === "text" || block.type === "thinking") && typeof block.text === "string") {
      return sum + block.text.length;
    }
    if (block.type === "toolCall") {
      const serializedArgs = JSON.stringify(block.arguments ?? {});
      const argsLength = typeof serializedArgs === "string" ? serializedArgs.length : 0;
      const nameLength = typeof block.name === "string" ? block.name.length : 0;
      return sum + argsLength + nameLength;
    }
    return sum;
  }, 0);
}

function normalizeUsagePercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent > 1) return Math.max(0, Math.min(1, percent / 100));
  return Math.max(0, Math.min(1, percent));
}
