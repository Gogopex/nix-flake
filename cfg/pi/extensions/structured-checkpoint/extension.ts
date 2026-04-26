import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface StructuredCheckpointConfig {
  enabled: boolean;
  model: string;
  maxTokens: number;
  includeRecentContext: boolean;
  debug: boolean;
}

const DEFAULT_CONFIG: StructuredCheckpointConfig = {
  enabled: false,
  model: "current",
  maxTokens: 8192,
  includeRecentContext: true,
  debug: false,
};

interface StructuredCheckpointState {
  goal: string;
  constraints: string[];
  current_plan: string[];
  next_actions: string[];
  active_files: string[];
  modified_files: string[];
  last_errors: string[];
  decisions: string[];
  open_questions: string[];
  blocked_by: string[];
  exact_strings_to_preserve: string[];
  artifacts: string[];
  branch_context: string[];
}

interface ToolCallMetadata {
  readPathByCallId: Map<string, string>;
  writePathByCallId: Map<string, string>;
  bashCommandByCallId: Map<string, string>;
}

interface ExtractionMessage {
  role: Message["role"];
  rawText: string;
  extractionText: string;
}

const EMPTY_STATE: StructuredCheckpointState = {
  goal: "",
  constraints: [],
  current_plan: [],
  next_actions: [],
  active_files: [],
  modified_files: [],
  last_errors: [],
  decisions: [],
  open_questions: [],
  blocked_by: [],
  exact_strings_to_preserve: [],
  artifacts: [],
  branch_context: [],
};

export default function structuredCheckpoint(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;

    const { preparation } = event;
    const messagesToSummarize = asMessageArray((preparation as { messagesToSummarize?: AgentMessage[] }).messagesToSummarize);
    const turnPrefixMessages = asMessageArray((preparation as { turnPrefixMessages?: AgentMessage[] }).turnPrefixMessages);
    const recentMessages = asMessageArray((preparation as { recentMessages?: AgentMessage[] }).recentMessages);

    const allMessages = config.includeRecentContext
      ? [...messagesToSummarize, ...turnPrefixMessages, ...recentMessages]
      : [...messagesToSummarize, ...turnPrefixMessages];

    const state = buildStructuredState(allMessages, preparation as {
      fileOps?: { read?: Set<string>; edited?: Set<string>; written?: Set<string> };
      isSplitTurn?: boolean;
      previousSummary?: string;
    });
    const summary = renderSummary(state);
    const shortSummary = buildShortSummary(state);

    if (config.debug) {
      ctx.ui.notify(
        `structured-checkpoint: heuristic checkpoint from ${allMessages.length} messages`,
        "info",
      );
    }

    return {
      compaction: {
        summary,
        shortSummary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: {
          source: "structured-checkpoint",
          version: 3,
          strategy: "heuristic",
          state,
        },
        preserveData: {
          structuredCheckpoint: state,
        },
      },
    };
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

function loadConfig(cwd: string): StructuredCheckpointConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.structuredCheckpoint && typeof global.structuredCheckpoint === "object"
    ? global.structuredCheckpoint
    : {}) as Record<string, unknown>;
  const p = (project.structuredCheckpoint && typeof project.structuredCheckpoint === "object"
    ? project.structuredCheckpoint
    : {}) as Record<string, unknown>;

  return {
    enabled: pick(p.enabled, g.enabled, DEFAULT_CONFIG.enabled),
    model: pick(p.model, g.model, DEFAULT_CONFIG.model),
    maxTokens: pick(p.maxTokens, g.maxTokens, DEFAULT_CONFIG.maxTokens),
    includeRecentContext: pick(p.includeRecentContext, g.includeRecentContext, DEFAULT_CONFIG.includeRecentContext),
    debug: pick(p.debug, g.debug, DEFAULT_CONFIG.debug),
  };
}

function pick<T>(project: unknown, global: unknown, fallback: T): T {
  if (project !== undefined && typeof project === typeof fallback) return project as T;
  if (global !== undefined && typeof global === typeof fallback) return global as T;
  return fallback;
}

function buildStructuredState(messages: AgentMessage[], preparation: {
  fileOps?: { read?: Set<string>; edited?: Set<string>; written?: Set<string> };
  isSplitTurn?: boolean;
  previousSummary?: string;
}): StructuredCheckpointState {
  const metadata = collectToolCallMetadata(messages);
  const previousState = parseStructuredStateFromSummary(preparation.previousSummary);
  const extractionMessages = messages.map((message) => analyzeMessage(message as Message));
  const conversationTexts = extractionMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.extractionText)
    .filter(Boolean);
  const assistantTexts = extractionMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.extractionText)
    .filter(Boolean);
  const recentUserTexts = collectRecentUserTexts(extractionMessages, 6);
  const recentUserLines = extractActionableUserLines(recentUserTexts).slice(0, 6);

  const readFiles = preparation.fileOps?.read ? Array.from(preparation.fileOps.read) : [];
  const editedFiles = preparation.fileOps?.edited ? Array.from(preparation.fileOps.edited) : [];
  const writtenFiles = preparation.fileOps?.written ? Array.from(preparation.fileOps.written) : [];
  const recentReadFiles = collectRecentToolPaths(messages, new Set(["read"]), 8);
  const recentWriteFiles = collectRecentToolPaths(messages, new Set(["write", "edit"]), 8);
  const activeFiles = unique([
    ...recentWriteFiles,
    ...recentReadFiles,
    ...writtenFiles,
    ...editedFiles,
    ...readFiles,
    ...Array.from(metadata.readPathByCallId.values()),
    ...Array.from(metadata.writePathByCallId.values()),
  ]).slice(0, 12);
  const modifiedFiles = unique([
    ...recentWriteFiles,
    ...writtenFiles,
    ...editedFiles,
    ...Array.from(metadata.writePathByCallId.values()),
  ]).slice(0, 12);
  const lastErrors = collectLastErrors(messages, metadata).slice(0, 8);
  const constraints = extractConstraintHints([...recentUserTexts, ...conversationTexts]).slice(0, 8);
  const decisions = extractDecisionHints(assistantTexts).slice(0, 8);
  const openQuestions = extractOpenQuestions(recentUserTexts.length > 0 ? recentUserTexts : conversationTexts).slice(0, 6);
  const validationProbes = detectValidationProbes(messages, metadata).slice(0, 6);
  const blockedBy = unique([
    ...extractBlockers(recentUserTexts),
    ...extractBlockers(assistantTexts),
    ...lastErrors,
  ]).slice(0, 6);
  const currentPlan = buildCurrentPlan({
    activeFiles,
    modifiedFiles,
    lastErrors,
    decisions,
    recentUserLines,
    validationProbes,
  }).slice(0, 6);
  const nextActions = buildNextActions({
    activeFiles,
    modifiedFiles,
    lastErrors,
    openQuestions,
    recentUserLines,
  }).slice(0, 6);
  const goal = deriveGoal(recentUserLines, recentUserTexts, conversationTexts, activeFiles);
  const exactStringsToPreserve = unique([
    ...activeFiles,
    ...modifiedFiles,
    ...collectRecentCommands(messages, metadata),
    ...lastErrors,
  ]).slice(0, 12);
  const branchContext = preparation.isSplitTurn ? ["Compaction occurred during a split turn."] : [];

  const state = {
    ...EMPTY_STATE,
    goal,
    constraints,
    current_plan: currentPlan,
    next_actions: nextActions,
    active_files: activeFiles,
    modified_files: modifiedFiles,
    last_errors: lastErrors,
    decisions,
    open_questions: openQuestions,
    blocked_by: blockedBy,
    exact_strings_to_preserve: exactStringsToPreserve,
    artifacts: validationProbes,
    branch_context: branchContext,
  };

  if (previousState && isLowSignalState(state)) {
    return mergeWithPreviousState(previousState, state);
  }

  return state;
}

function analyzeMessage(message: Message): ExtractionMessage {
  const rawText = getMessageText(message);
  return {
    role: message.role,
    rawText,
    extractionText: sanitizeExtractionText(rawText),
  };
}

function asMessageArray(value: unknown): AgentMessage[] {
  return Array.isArray(value) ? (value as AgentMessage[]) : [];
}

function collectToolCallMetadata(messages: AgentMessage[]): ToolCallMetadata {
  const readPathByCallId = new Map<string, string>();
  const writePathByCallId = new Map<string, string>();
  const bashCommandByCallId = new Map<string, string>();

  for (const raw of messages) {
    const msg = raw as Message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!block || block.type !== "toolCall") continue;
      const toolName = block.name.toLowerCase();
      if (toolName === "read") {
        const maybePath = (block.arguments as { path?: string } | undefined)?.path;
        if (maybePath) readPathByCallId.set(block.id, maybePath);
      }
      if (toolName === "write") {
        const maybePath = (block.arguments as { path?: string } | undefined)?.path;
        if (maybePath) writePathByCallId.set(block.id, maybePath);
      }
      if (toolName === "edit") {
        const maybePath = (block.arguments as { path?: string; filePath?: string } | undefined)?.path
          ?? (block.arguments as { path?: string; filePath?: string } | undefined)?.filePath;
        if (maybePath) writePathByCallId.set(block.id, maybePath);
      }
      if (toolName === "bash") {
        const maybeCommand = (block.arguments as { command?: string } | undefined)?.command;
        if (maybeCommand) bashCommandByCallId.set(block.id, maybeCommand);
      }
    }
  }

  return { readPathByCallId, writePathByCallId, bashCommandByCallId };
}

function collectRecentUserTexts(messages: ExtractionMessage[], limit: number): string[] {
  const results: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const text = msg.extractionText.trim();
    if (!text) continue;
    results.push(text);
    if (results.length >= limit) break;
  }
  return results;
}

function deriveGoal(
  recentUserLines: string[],
  recentUserTexts: string[],
  extractionTexts: string[],
  activeFiles: string[],
): string {
  const strongUserLines = recentUserLines.filter((line) => !isWeakGoalText(line));
  if (strongUserLines.length >= 2) {
    return truncateInline(
      `Improve structured-checkpoint heuristics: ${strongUserLines.slice(0, 3).map(stripListMarker).join("; ")}`,
      240,
    );
  }
  if (strongUserLines[0]) return truncateInline(stripListMarker(strongUserLines[0]), 240);

  for (const text of recentUserTexts) {
    const candidate = firstNonWeakLine(text);
    if (candidate) return truncateInline(candidate, 240);
  }

  for (let i = extractionTexts.length - 1; i >= 0; i--) {
    const candidate = firstNonWeakLine(extractionTexts[i]);
    if (candidate) return truncateInline(candidate, 240);
  }

  if (activeFiles[0]) return `Continue work in ${activeFiles[0]}`;
  return "Continue the current coding task";
}

function collectLastErrors(messages: AgentMessage[], metadata: ToolCallMetadata): string[] {
  const errors: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg.role !== "toolResult") continue;
    const toolName = msg.toolName?.toLowerCase();
    if (!msg.isError && toolName !== "bash") continue;

    const summary = summarizeToolError(msg as ToolResultMessage, metadata);
    if (!summary) continue;

    errors.push(summary);
    if (errors.length >= 8) break;
  }

  return unique(errors);
}

function summarizeToolError(toolResult: ToolResultMessage, metadata: ToolCallMetadata): string {
  const toolName = toolResult.toolName?.toLowerCase() ?? "tool";
  const text = getTextContent(toolResult).trim();
  const lines = splitMeaningfulLines(text);
  const signature = extractPrimaryErrorLine(lines);

  if (toolName === "bash") {
    if (!toolResult.isError && !signature) return "";
    const command = metadata.bashCommandByCallId.get(toolResult.toolCallId);
    const commandSummary = command ? summarizeCommand(command) : "bash";
    const errorSummary = signature ?? (toolResult.isError ? "bash command failed" : "bash output signalled an error");
    return `${commandSummary}: ${truncateInline(errorSummary, 220)}`;
  }

  if (!toolResult.isError && !signature) return "";
  return `${toolName}: ${truncateInline(signature ?? firstLine(text || "tool execution failed", 220), 220)}`;
}

function extractPrimaryErrorLine(lines: string[]): string {
  if (lines.length === 0) return "";

  const patterns = [
    /Failed to load extension:/i,
    /\b(?:ModuleNotFoundError|TypeError|ReferenceError|SyntaxError|BuildMessage)\b/i,
    /\b[A-Za-z]+(?:Error|Exception)\b/i,
    /\b(?:error|failed|panic|fatal|not found|cannot|can't|missing)\b/i,
    /Command exited with code/i,
  ];

  for (const pattern of patterns) {
    const match = lines.find((line) => pattern.test(line));
    if (match) return stripAnsiAndQuotes(match);
  }

  return "";
}

function collectRecentCommands(messages: AgentMessage[], metadata: ToolCallMetadata): string[] {
  const commands: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg.role !== "toolResult" || msg.toolName?.toLowerCase() !== "bash") continue;
    const command = metadata.bashCommandByCallId.get(msg.toolCallId);
    if (command) commands.push(summarizeCommand(command));
    if (commands.length >= 4) break;
  }
  return unique(commands);
}

function collectRecentToolPaths(messages: AgentMessage[], toolNames: Set<string>, limit: number): string[] {
  const paths: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (!block || block.type !== "toolCall") continue;
      const toolName = block.name.toLowerCase();
      if (!toolNames.has(toolName)) continue;

      const maybePath = (block.arguments as { path?: string; filePath?: string } | undefined)?.path
        ?? (block.arguments as { path?: string; filePath?: string } | undefined)?.filePath;
      if (!maybePath) continue;

      paths.push(maybePath);
      if (paths.length >= limit) return unique(paths);
    }
  }

  return unique(paths);
}

function detectValidationProbes(messages: AgentMessage[], metadata: ToolCallMetadata): string[] {
  const probes: string[] = [];
  const repeatedReads = new Map<string, number>();
  const repeatedBashFailures = new Map<string, { count: number; description: string }>();

  for (const raw of messages) {
    const msg = raw as Message;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || block.type !== "toolCall") continue;
        const toolName = block.name.toLowerCase();
        if (toolName === "read") {
          const filePath = (block.arguments as { path?: string } | undefined)?.path;
          if (filePath) repeatedReads.set(filePath, (repeatedReads.get(filePath) ?? 0) + 1);
        }
      }
    }

    if (msg.role === "toolResult" && msg.toolName?.toLowerCase() === "bash") {
      const summary = summarizeToolError(msg as ToolResultMessage, metadata);
      if (!summary) continue;
      const command = metadata.bashCommandByCallId.get(msg.toolCallId);
      const key = `${command ?? "bash"}::${summary}`;
      const entry = repeatedBashFailures.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        repeatedBashFailures.set(key, { count: 1, description: summary });
      }
    }
  }

  for (const [filePath, count] of repeatedReads.entries()) {
    if (count >= 2) probes.push(`Validation probe: repeated read of ${filePath} (${count}x recently).`);
  }

  for (const { count, description } of repeatedBashFailures.values()) {
    if (count >= 2) probes.push(`Validation probe: repeated bash failure ${description} (${count}x).`);
  }

  const recentRawText = messages.slice(-16).map((message) => getMessageText(message as Message)).join("\n");
  if (/\bReloaded keybindings, extensions, skills, prompts, themes\b/i.test(recentRawText) || /\breload worked\b/i.test(recentRawText)) {
    probes.push("Recent reload outcome was observed in the conversation.");
  }
  if (/\bCompacted from\s+[\d,]+\s+tokens\b/i.test(recentRawText) || /\[compaction\]/i.test(recentRawText)) {
    probes.push("Recent compaction transcript was present in context.");
  }

  return unique(probes);
}

function extractConstraintHints(texts: string[]): string[] {
  return unique(
    texts.flatMap((text) =>
      splitCandidateLines(text).filter((line) => /\b(must|should|avoid|default off|toggle|do not|don't|never|prefer)\b/i.test(line)),
    ),
  );
}

function extractDecisionHints(texts: string[]): string[] {
  return unique(
    texts.flatMap((text) =>
      splitCandidateLines(text).filter((line) => /\b(decide|decision|chosen|use |prefer |plan:|next:|we will|keep )\b/i.test(line)),
    ),
  );
}

function extractOpenQuestions(texts: string[]): string[] {
  return unique(
    texts.flatMap((text) => splitCandidateLines(text).filter((line) => line.includes("?"))),
  );
}

function extractBlockers(texts: string[]): string[] {
  return unique(
    texts.flatMap((text) =>
      splitCandidateLines(text).filter((line) => /\b(blocked|missing|cannot|can't|failed|not found|error)\b/i.test(line)),
    ),
  );
}

function extractActionableUserLines(texts: string[]): string[] {
  const lines: string[] = [];

  for (const text of texts) {
    for (const line of splitCandidateLines(text)) {
      const normalized = stripListMarker(line);
      if (!normalized || isWeakGoalText(normalized)) continue;
      if (/^(goal|current plan|active files|modified files|last errors|decisions|blockers|next actions|structured state)/i.test(normalized)) {
        continue;
      }
      lines.push(truncateInline(normalized, 180));
    }
  }

  return unique(lines);
}

function buildCurrentPlan(input: {
  activeFiles: string[];
  modifiedFiles: string[];
  lastErrors: string[];
  decisions: string[];
  recentUserLines: string[];
  validationProbes: string[];
}): string[] {
  const plan: string[] = [];

  for (const line of input.recentUserLines.slice(0, 3)) {
    plan.push(line);
  }
  if (input.activeFiles.length > 0) {
    plan.push(`Maintain context for active files: ${input.activeFiles.slice(0, 4).join(", ")}`);
  }
  if (input.modifiedFiles.length > 0) {
    plan.push(`Carry forward modifications in: ${input.modifiedFiles.slice(0, 4).join(", ")}`);
  }
  if (input.lastErrors.length > 0) {
    plan.push("Resolve the latest failing command or tool error before widening scope.");
  }
  if (input.validationProbes.length > 0) {
    plan.push("Preserve recent validation probes when summarizing session state.");
  }
  if (input.decisions.length > 0) {
    plan.push(`Respect prior decisions: ${input.decisions[0]}`);
  }

  return unique(plan);
}

function buildNextActions(input: {
  activeFiles: string[];
  modifiedFiles: string[];
  lastErrors: string[];
  openQuestions: string[];
  recentUserLines: string[];
}): string[] {
  const actions: string[] = [];

  for (const line of input.recentUserLines.slice(0, 4)) {
    actions.push(line);
  }
  if (input.lastErrors.length > 0) {
    actions.push("Address the latest error and rerun the relevant command/check.");
  }
  if (input.modifiedFiles[0]) {
    actions.push(`Continue implementation in ${input.modifiedFiles[0]}.`);
  } else if (input.activeFiles[0]) {
    actions.push(`Inspect or continue work in ${input.activeFiles[0]}.`);
  }
  if (input.openQuestions[0]) {
    actions.push(`Resolve open question: ${truncateInline(input.openQuestions[0], 180)}`);
  }
  if (actions.length === 0) {
    actions.push("Continue the current task from the most recent user instruction.");
  }

  return unique(actions);
}

function renderSummary(state: StructuredCheckpointState): string {
  const sections = [
    `## Goal\n${state.goal || "Continue the current coding task"}`,
    state.current_plan.length > 0 ? `## Current Plan\n${bulletList(state.current_plan)}` : undefined,
    state.active_files.length > 0 ? `## Active Files\n${bulletList(state.active_files)}` : undefined,
    state.modified_files.length > 0 ? `## Modified Files\n${bulletList(state.modified_files)}` : undefined,
    state.last_errors.length > 0 ? `## Last Errors\n${bulletList(state.last_errors)}` : undefined,
    state.decisions.length > 0 ? `## Decisions\n${bulletList(state.decisions)}` : undefined,
    state.open_questions.length > 0 ? `## Open Questions\n${bulletList(state.open_questions)}` : undefined,
    state.blocked_by.length > 0 ? `## Blockers\n${bulletList(state.blocked_by)}` : undefined,
    state.artifacts.length > 0 ? `## Artifacts\n${bulletList(state.artifacts)}` : undefined,
    state.next_actions.length > 0 ? `## Next Actions\n${bulletList(state.next_actions)}` : undefined,
    `## Structured State (JSON)\n\n<structured-state>\n${JSON.stringify(state, null, 2)}\n</structured-state>`,
  ].filter((section): section is string => Boolean(section));

  return sections.join("\n\n");
}

function buildShortSummary(state: StructuredCheckpointState): string | undefined {
  if (state.goal) return truncateInline(state.goal, 120);
  if (state.next_actions[0]) return truncateInline(state.next_actions[0], 120);
  if (state.active_files[0]) return truncateInline(`Working in ${state.active_files[0]}`, 120);
  return undefined;
}

function parseStructuredStateFromSummary(summary: unknown): StructuredCheckpointState | undefined {
  if (typeof summary !== "string" || !summary.trim()) return undefined;

  const match = summary.match(/<structured-state>\s*([\s\S]*?)\s*<\/structured-state>/i);
  if (!match?.[1]) return undefined;

  try {
    return normalizeStructuredState(JSON.parse(match[1]) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function normalizeStructuredState(value: Record<string, unknown>): StructuredCheckpointState {
  return {
    goal: typeof value.goal === "string" ? value.goal : "",
    constraints: toStringArray(value.constraints),
    current_plan: toStringArray(value.current_plan),
    next_actions: toStringArray(value.next_actions),
    active_files: toStringArray(value.active_files),
    modified_files: toStringArray(value.modified_files),
    last_errors: toStringArray(value.last_errors),
    decisions: toStringArray(value.decisions),
    open_questions: toStringArray(value.open_questions),
    blocked_by: toStringArray(value.blocked_by),
    exact_strings_to_preserve: toStringArray(value.exact_strings_to_preserve),
    artifacts: toStringArray(value.artifacts),
    branch_context: toStringArray(value.branch_context),
  };
}

function isLowSignalState(state: StructuredCheckpointState): boolean {
  const usefulGoal = state.goal && state.goal !== "Continue the current coding task" && !isWeakGoalText(state.goal);
  const nonGenericActions = state.next_actions.filter((action) => !isGenericContinuationAction(action));
  const score =
    (usefulGoal ? 2 : 0)
    + Math.min(state.current_plan.length, 2)
    + Math.min(nonGenericActions.length, 2)
    + Math.min(state.active_files.length, 2)
    + Math.min(state.modified_files.length, 2)
    + Math.min(state.last_errors.length, 2)
    + Math.min(state.decisions.length, 1)
    + Math.min(state.artifacts.length, 1);

  return score < 2;
}

function mergeWithPreviousState(
  previous: StructuredCheckpointState,
  current: StructuredCheckpointState,
): StructuredCheckpointState {
  const merged: StructuredCheckpointState = {
    goal: pickPreferredGoal(current, previous),
    constraints: mergeStringLists(current.constraints, previous.constraints, 8),
    current_plan: mergeStringLists(current.current_plan, previous.current_plan, 6),
    next_actions: mergeActionLists(current.next_actions, previous.next_actions, 6),
    active_files: mergeStringLists(current.active_files, previous.active_files, 12),
    modified_files: mergeStringLists(current.modified_files, previous.modified_files, 12),
    last_errors: mergeStringLists(current.last_errors, previous.last_errors, 8),
    decisions: mergeStringLists(current.decisions, previous.decisions, 8),
    open_questions: mergeStringLists(current.open_questions, previous.open_questions, 6),
    blocked_by: mergeStringLists(current.blocked_by, previous.blocked_by, 6),
    exact_strings_to_preserve: mergeStringLists(current.exact_strings_to_preserve, previous.exact_strings_to_preserve, 12),
    artifacts: mergeStringLists(
      [...current.artifacts, "Low-signal compaction: carried forward prior structured state."],
      previous.artifacts,
      6,
    ),
    branch_context: mergeStringLists(current.branch_context, previous.branch_context, 4),
  };

  if (merged.current_plan.length === 0 && merged.active_files.length > 0) {
    merged.current_plan = [`Maintain context for active files: ${merged.active_files.slice(0, 4).join(", ")}`];
  }
  if (merged.next_actions.length === 0) {
    merged.next_actions = merged.active_files[0]
      ? [`Inspect or continue work in ${merged.active_files[0]}.`]
      : ["Continue the current task from the most recent user instruction."];
  }

  return merged;
}

function pickPreferredGoal(current: StructuredCheckpointState, previous: StructuredCheckpointState): string {
  if (current.goal && current.goal !== "Continue the current coding task" && !isWeakGoalText(current.goal)) {
    return current.goal;
  }
  if (previous.goal && previous.goal !== "Continue the current coding task") {
    return previous.goal;
  }
  if (current.active_files[0]) return `Continue work in ${current.active_files[0]}`;
  if (previous.active_files[0]) return `Continue work in ${previous.active_files[0]}`;
  return current.goal || previous.goal || "Continue the current coding task";
}

function mergeActionLists(current: string[], previous: string[], limit: number): string[] {
  const filteredCurrent = current.filter((action) => !isGenericContinuationAction(action));
  const filteredPrevious = previous.filter((action) => !isGenericContinuationAction(action));
  const merged = unique([...filteredCurrent, ...filteredPrevious]).slice(0, limit);

  if (merged.length > 0) return merged;
  if (current.length > 0) return unique(current).slice(0, limit);
  if (previous.length > 0) return unique(previous).slice(0, limit);
  return [];
}

function mergeStringLists(current: string[], previous: string[], limit: number): string[] {
  return unique([...current, ...previous]).slice(0, limit);
}

function isGenericContinuationAction(action: string): boolean {
  return /^Continue the current task from the most recent user instruction\.?$/i.test(action.trim());
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getMessageText(message: Message): string {
  if (!message || typeof message !== "object") return "";

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item): item is TextContent => Boolean(item) && item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function getTextContent(toolResult: ToolResultMessage): string {
  const content = (toolResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item): item is TextContent => Boolean(item) && item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function sanitizeExtractionText(text: string): string {
  if (!text) return "";

  const normalized = text.replace(/\r/g, "");
  const withoutStructuredState = normalized.replace(/<structured-state>[\s\S]*?<\/structured-state>/gi, " ");
  if (looksLikePriorCheckpoint(withoutStructuredState)) return "";

  return withoutStructuredState
    .replace(/^\s*\[compaction\]\s*$/gim, " ")
    .replace(/^\s*Compacted from[^\n]*$/gim, " ")
    .trim();
}

function looksLikePriorCheckpoint(text: string): boolean {
  if (!text) return false;
  if (/Structured State \(JSON\)/i.test(text)) return true;

  const headingMatches = text.match(/^\s*(?:##\s+)?(Goal|Current Plan|Active Files|Modified Files|Last Errors|Decisions|Open Questions|Blockers|Artifacts|Next Actions|Structured State(?: \(JSON\))?)\s*$/gim);
  const headingCount = headingMatches?.length ?? 0;
  const hasCompactionMarker = /\[compaction\]|\bCompacted from\s+[\d,]+\s+tokens\b/i.test(text);
  return (hasCompactionMarker && headingCount >= 2) || headingCount >= 4;
}

function splitCandidateLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => truncateInline(line, 220));
}

function splitMeaningfulLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => stripAnsiAndQuotes(line.trim()))
    .filter(Boolean);
}

function summarizeCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  const bunInline = singleLine.replace(/bun -e\s+(['"]).*$/i, "bun -e <inline script>");
  const pythonInline = bunInline.replace(/python\s+-c\s+(['"]).*$/i, "python -c <inline script>");
  return truncateInline(pythonInline, 120);
}

function firstNonWeakLine(text: string): string {
  for (const line of splitCandidateLines(text)) {
    const normalized = stripListMarker(line);
    if (!normalized || isWeakGoalText(normalized)) continue;
    return normalized;
  }
  return "";
}

function stripListMarker(value: string): string {
  return value.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
}

function isWeakGoalText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 10) return true;
  if (/^(good|great|nice|oops|ok|okay|thanks|thank you|reloaded|reload worked|worked|done)[!. ]*$/.test(normalized)) return true;
  if (/^let'?s do all of these!?$/.test(normalized)) return true;
  return false;
}

function stripAnsiAndQuotes(value: string): string {
  return value.replace(/^["']+|["']+$/g, "").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function bulletList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function firstLine(value: string, maxChars: number): string {
  return truncateInline(value.split("\n").map((line) => line.trim()).find(Boolean) ?? "", maxChars);
}

function truncateInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
