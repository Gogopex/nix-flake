import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

type HistoryConfig = { enabled: boolean; maxItems: number };

type PromptEntry = { text: string; normalized: string; ts: number; session: string };

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

const DEFAULT_CONFIG: HistoryConfig = { enabled: true, maxItems: 200 };

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

function loadConfig(cwd: string): HistoryConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.historySearchV2 && typeof global.historySearchV2 === "object"
    ? (global.historySearchV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const p = (project.historySearchV2 && typeof project.historySearchV2 === "object"
    ? (project.historySearchV2 as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const enabled = typeof p.enabled === "boolean" ? p.enabled : typeof g.enabled === "boolean" ? g.enabled : DEFAULT_CONFIG.enabled;
  const maxItemsRaw = typeof p.maxItems === "number" ? p.maxItems : typeof g.maxItems === "number" ? g.maxItems : DEFAULT_CONFIG.maxItems;
  const maxItems = Math.max(20, Math.min(1000, Math.floor(maxItemsRaw)));

  return { enabled, maxItems };
}

function writeGlobalConfig(partial: Partial<HistoryConfig>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJson(settingsPath);
  const existing = current.historySearchV2 && typeof current.historySearchV2 === "object"
    ? (current.historySearchV2 as Record<string, unknown>)
    : {};
  current.historySearchV2 = { ...existing, ...partial };
  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function collectSessionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function extractPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .filter((p) => p.type === "text")
    .map((p) => String(p.text || ""))
    .join("");
}

function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseUserPrompts(limit: number): PromptEntry[] {
  const sessionsDir = path.join(getAgentDir(), "sessions");
  const files = collectSessionFiles(sessionsDir);
  const raw: PromptEntry[] = [];

  for (const file of files) {
    let statMtime = 0;
    try {
      statMtime = fs.statSync(file).mtimeMs;
    } catch {
      statMtime = 0;
    }

    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "message") continue;

        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "user") continue;

        const normalized = normalizePrompt(extractPromptText(msg.content));
        if (!normalized) continue;

        const ts = typeof msg.timestamp === "number" ? msg.timestamp : statMtime;
        raw.push({
          text: normalized,
          normalized,
          ts,
          session: path.basename(file, ".jsonl"),
        });
      } catch {
        // ignore malformed lines
      }
    }
  }

  raw.sort((a, b) => b.ts - a.ts);

  // Dedup by normalized lower-case prompt, keeping newest
  const seen = new Set<string>();
  const deduped: PromptEntry[] = [];
  for (const prompt of raw) {
    const key = prompt.normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(prompt);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

class HistoryResultsList implements Component {
  #results: PromptEntry[] = [];
  #selectedIndex = 0;
  #maxVisible = 10;
  #theme: ThemeLike;

  constructor(theme: ThemeLike) {
    this.#theme = theme;
  }

  setResults(results: PromptEntry[], selectedIndex: number): void {
    this.#results = results;
    this.#selectedIndex = selectedIndex;
  }

  setSelectedIndex(selectedIndex: number): void {
    this.#selectedIndex = selectedIndex;
  }

  invalidate(): void {
    // no cached render state
  }

  render(width: number): string[] {
    if (this.#results.length === 0) {
      return [this.#theme.fg("muted", "  No matching history")];
    }

    const lines: string[] = [];
    const startIndex = Math.max(
      0,
      Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), this.#results.length - this.#maxVisible),
    );
    const endIndex = Math.min(startIndex + this.#maxVisible, this.#results.length);

    for (let i = startIndex; i < endIndex; i++) {
      const entry = this.#results[i];
      const isSelected = i === this.#selectedIndex;

      const cursor = "> ";
      const cursorWidth = visibleWidth(cursor);
      const marker = isSelected ? this.#theme.fg("accent", cursor) : " ".repeat(Math.max(0, cursorWidth));
      const maxWidth = Math.max(1, width - cursorWidth);

      const text = truncateToWidth(entry.normalized, maxWidth);
      lines.push(marker + (isSelected ? this.#theme.bold(text) : text));
    }

    if (startIndex > 0 || endIndex < this.#results.length) {
      lines.push(this.#theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.#results.length})`));
    }

    return lines;
  }
}

class HistorySearchComponent extends Container {
  #allEntries: PromptEntry[];
  #searchInput: Input;
  #results: PromptEntry[] = [];
  #selectedIndex = 0;
  #resultsList: HistoryResultsList;
  #onSelect: (prompt: string) => void;
  #onCancel: () => void;

  constructor(entries: PromptEntry[], theme: ThemeLike, onSelect: (prompt: string) => void, onCancel: () => void) {
    super();
    this.#allEntries = entries;
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;

    this.#searchInput = new Input();
    this.#searchInput.onSubmit = () => {
      const selected = this.#results[this.#selectedIndex];
      if (selected) this.#onSelect(selected.text);
    };
    this.#searchInput.onEscape = () => {
      this.#onCancel();
    };

    this.#resultsList = new HistoryResultsList(theme);

    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.bold(theme.fg("accent", "Search Prompt History (Ctrl+R)")), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.#searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.#resultsList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("muted", "up/down navigate  enter insert  esc cancel"), 1, 0));

    this.#updateResults();
  }

  handleInput(keyData: string): void {
    if (matchesKey(keyData, "ctrl+r")) {
      return;
    }

    if (matchesKey(keyData, "up")) {
      if (this.#results.length === 0) return;
      this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
      this.#resultsList.setSelectedIndex(this.#selectedIndex);
      return;
    }

    if (matchesKey(keyData, "down")) {
      if (this.#results.length === 0) return;
      this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
      this.#resultsList.setSelectedIndex(this.#selectedIndex);
      return;
    }

    if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
      const selected = this.#results[this.#selectedIndex];
      if (selected) this.#onSelect(selected.text);
      return;
    }

    if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
      this.#onCancel();
      return;
    }

    this.#searchInput.handleInput(keyData);
    this.#updateResults();
  }

  #updateResults(): void {
    const query = this.#searchInput.getValue().trim().toLowerCase();
    this.#results = query
      ? this.#allEntries.filter((entry) => entry.normalized.toLowerCase().includes(query))
      : this.#allEntries;

    this.#selectedIndex = 0;
    this.#resultsList.setResults(this.#results, this.#selectedIndex);
  }
}

export default function historySearchV2(pi: ExtensionAPI) {
  const openPicker = async (ctx: {
    cwd: string;
    ui: {
      notify: (message: string, level: "info" | "warning" | "success" | "error") => void;
      custom: <T>(factory: (tui: { requestRender: () => void }, theme: ThemeLike, keybindings: unknown, done: (value: T) => void) => Component) => Promise<T>;
      setEditorText: (text: string) => void;
    };
  }): Promise<void> => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return;

    const prompts = parseUserPrompts(cfg.maxItems);
    if (prompts.length === 0) {
      ctx.ui.notify("No prompt history yet", "info");
      return;
    }

    const selected = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
      return new HistorySearchComponent(
        prompts,
        theme,
        (prompt) => done(prompt),
        () => done(null),
      );
    });

    if (!selected) return;
    ctx.ui.setEditorText(selected);
  };

  pi.registerShortcut("ctrl+r", {
    description: "Open persistent prompt history search",
    handler: async (ctx) => {
      await openPicker(ctx);
    },
  });

  pi.registerCommand("history-v2", {
    description: "History v2: on|off|show|open",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();
      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        ctx.ui.notify("history-v2 enabled", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        ctx.ui.notify("history-v2 disabled", "success");
        return;
      }
      if (cmd === "open") {
        await openPicker(ctx);
        return;
      }
      const cfg = loadConfig(ctx.cwd);
      ctx.ui.notify(`history-v2 enabled=${cfg.enabled} maxItems=${cfg.maxItems}`, "info");
    },
  });
}
