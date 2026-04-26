import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

type ReviewConfig = { enabled: boolean };

type Priority = "P0" | "P1" | "P2" | "P3";

type Finding = {
  priority: Priority;
  title: string;
  file?: string;
  line?: number;
  body: string;
};

const DEFAULT_CONFIG: ReviewConfig = { enabled: true };

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

function loadConfig(cwd: string): ReviewConfig {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));

  const g = (global.reviewV2 && typeof global.reviewV2 === "object" ? (global.reviewV2 as Record<string, unknown>) : {}) as Record<string, unknown>;
  const p = (project.reviewV2 && typeof project.reviewV2 === "object" ? (project.reviewV2 as Record<string, unknown>) : {}) as Record<string, unknown>;

  const enabled = typeof p.enabled === "boolean" ? p.enabled : typeof g.enabled === "boolean" ? g.enabled : DEFAULT_CONFIG.enabled;
  return { enabled };
}

function writeGlobalConfig(partial: Partial<ReviewConfig>): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  const current = readJson(settingsPath);
  const existing = current.reviewV2 && typeof current.reviewV2 === "object"
    ? (current.reviewV2 as Record<string, unknown>)
    : {};
  current.reviewV2 = { ...existing, ...partial };
  fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function verdictFor(findings: Finding[]): "approve" | "request_changes" | "comment" {
  if (findings.some((f) => f.priority === "P0" || f.priority === "P1")) return "request_changes";
  if (findings.length === 0) return "approve";
  return "comment";
}

export default function reviewV2(pi: ExtensionAPI) {
  let findings: Finding[] = [];

  pi.registerTool({
    name: "report_finding",
    label: "Report Finding",
    description: "Record one structured review finding with priority P0-P3.",
    parameters: Type.Object({
      priority: StringEnum(["P0", "P1", "P2", "P3"] as const),
      title: Type.String(),
      file: Type.Optional(Type.String()),
      line: Type.Optional(Type.Number()),
      body: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const finding: Finding = {
        priority: params.priority as Priority,
        title: params.title,
        file: params.file,
        line: params.line,
        body: params.body,
      };
      findings.push(finding);
      return {
        content: [{ type: "text", text: `Recorded ${finding.priority}: ${finding.title}` }],
        details: finding,
      };
    },
    renderResult(result, _options, theme) {
      const f = (result.details || {}) as Partial<Finding>;
      const line = `${theme.fg("accent", f.priority || "P?")} ${theme.fg("text", f.title || "finding")}`;
      return new Text(line, 0, 0);
    },
  });

  pi.registerCommand("review", {
    description: "Start structured review (branch|uncommitted|commit)",
    handler: async (_args, ctx) => {
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.enabled) {
        ctx.ui.notify("review-v2 disabled", "warning");
        return;
      }

      const mode = await ctx.ui.select("Review mode", [
        "branch (HEAD vs main)",
        "uncommitted changes",
        "single commit",
      ]);
      if (!mode) return;

      findings = [];

      const reviewInstruction = [
        "Run a code review now.",
        `Mode: ${mode}`,
        "For each issue found, call report_finding with priority P0..P3 and clear remediation guidance.",
        "Priorities:",
        "- P0: critical/correctness/security",
        "- P1: major bug/risk",
        "- P2: moderate maintainability or edge-case issue",
        "- P3: minor improvement/nit",
        "After collecting findings, provide a final verdict: approve / request_changes / comment.",
      ].join("\n");

      pi.sendUserMessage(reviewInstruction, { deliverAs: "followUp" });
      ctx.ui.notify("Queued structured review", "success");
    },
  });

  pi.registerCommand("review-summary", {
    description: "Show aggregated findings from latest /review run",
    handler: async (_args, ctx) => {
      const verdict = verdictFor(findings);

      if (findings.length === 0) {
        ctx.ui.notify(`review-summary: verdict=${verdict} (no findings)`, "info");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.bold(theme.fg("accent", `Review Summary (${verdict})`)), 1, 0));
        container.addChild(new Spacer(1));

        const lines = findings.map((f, i) => {
          const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
          return `${i + 1}. **${f.priority}** ${f.title}${loc}\n   - ${f.body}`;
        });

        container.addChild(new Markdown(lines.join("\n\n"), 1, 0, {
          heading: (text: string) => theme.bold(theme.fg("accent", text)),
          text: (text: string) => theme.fg("text", text),
          emphasis: (text: string) => theme.fg("warning", text),
          strong: (text: string) => theme.bold(theme.fg("text", text)),
          code: (text: string) => theme.fg("muted", text),
          codeBlock: (text: string) => theme.fg("muted", text),
          blockquote: (text: string) => theme.fg("muted", text),
          hr: (text: string) => theme.fg("dim", text),
          link: (text: string) => theme.fg("accent", text),
          linkUrl: (text: string) => theme.fg("muted", text),
          listBullet: (text: string) => theme.fg("muted", text),
        }));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "Esc or Enter to close"), 1, 0));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (_data: string) => done(undefined),
        };
      });
    },
  });

  pi.registerCommand("review-v2", {
    description: "review-v2: on|off|show|clear",
    handler: async (args, ctx) => {
      const cmd = (args || "show").trim().toLowerCase();
      if (cmd === "on") {
        writeGlobalConfig({ enabled: true });
        ctx.ui.notify("review-v2 enabled", "success");
        return;
      }
      if (cmd === "off") {
        writeGlobalConfig({ enabled: false });
        ctx.ui.notify("review-v2 disabled", "success");
        return;
      }
      if (cmd === "clear") {
        findings = [];
        ctx.ui.notify("review-v2 findings cleared", "success");
        return;
      }
      const cfg = loadConfig(ctx.cwd);
      ctx.ui.notify(`review-v2 enabled=${cfg.enabled} findings=${findings.length}`, "info");
    },
  });
}
