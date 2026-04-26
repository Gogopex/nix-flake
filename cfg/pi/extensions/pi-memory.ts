import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pi Project Memory Extension
 * 
 * Inspired by Claude Code's auto-memory.
 * Maintains persistent .pi/memory/*.md files for the project.
 */
export default function (pi: ExtensionAPI) {
  const getProjectMemoryDir = (cwd: string) => path.join(cwd, ".pi", "memory");
  const getGlobalMemoryDir = () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent"), "memory");

  // Tool: save_memory
  pi.registerTool({
    name: "save_memory",
    label: "Save Memory",
    description: "Update or create a persistent project memory file. Use semantic filenames like 'architecture.md' or 'api_design.md'. Files are stored in .pi/memory/ by default.",
    parameters: Type.Object({
      name: Type.String({ description: "Semantic filename (e.g., 'architecture.md')" }),
      content: Type.String({ description: "Markdown content" }),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "Memory scope (project or global). Defaults to project." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope || "project";
      const dir = scope === "project" ? getProjectMemoryDir(ctx.cwd) : getGlobalMemoryDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      const fileName = params.name.endsWith(".md") ? params.name : `${params.name}.md`;
      const filePath = path.join(dir, fileName);
      
      if (!filePath.startsWith(dir)) {
        throw new Error("Invalid memory filename");
      }

      const timestamp = new Date().toISOString();
      const sessionId = ctx.sessionManager.getLeafId();
      
      const frontmatter = `---
timestamp: ${timestamp}
session: ${sessionId}
scope: ${scope}
---
`;
      fs.writeFileSync(filePath, frontmatter + params.content, "utf8");
      
      return { 
        content: [{ type: "text", text: `Memory saved to ${scope} memory: ${fileName}` }],
        details: { path: fileName, timestamp, scope }
      };
    }
  });

  // Tool: read_memory
  pi.registerTool({
    name: "read_memory",
    label: "Read Memory",
    description: "Read a specific project or global memory file.",
    parameters: Type.Object({
      name: Type.String({ description: "Filename (e.g., 'architecture.md')" }),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "Memory scope (project or global). Defaults to project." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope || "project";
      const fileName = params.name.endsWith(".md") ? params.name : `${params.name}.md`;
      const dir = scope === "project" ? getProjectMemoryDir(ctx.cwd) : getGlobalMemoryDir();
      const filePath = path.join(dir, fileName);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`${scope} memory ${fileName} not found.`);
      }
      
      const content = fs.readFileSync(filePath, "utf8");
      return { 
        content: [{ type: "text", text: content }],
        details: { path: fileName, scope }
      };
    }
  });

  // Tool: list_memories
  pi.registerTool({
    name: "list_memories",
    label: "List Memories",
    description: "List all project and global memories.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const projectDir = getProjectMemoryDir(ctx.cwd);
      const globalDir = getGlobalMemoryDir();
      
      const projectFiles = fs.existsSync(projectDir) ? fs.readdirSync(projectDir).filter(f => f.endsWith(".md")) : [];
      const globalFiles = fs.existsSync(globalDir) ? fs.readdirSync(globalDir).filter(f => f.endsWith(".md")) : [];
      
      let text = "Project Memories (.pi/memory/):\n";
      text += projectFiles.length ? projectFiles.join("\n") : "None";
      text += "\n\nGlobal Memories (~/.pi/agent/memory/):\n";
      text += globalFiles.length ? globalFiles.join("\n") : "None";

      return { 
        content: [{ type: "text", text }],
        details: { projectFiles, globalFiles }
      };
    }
  });

  // Command: /consolidate
  pi.registerCommand("consolidate", {
    description: "Synthesize session learnings into project memories",
    getArgumentCompletions: (prefix: string) => {
      const models = [
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3-flash-preview",
        "anthropic/claude-3-5-haiku"
      ];
      return models.filter(m => m.startsWith(prefix)).map(m => ({ value: m, label: m }));
    },
    handler: async (args, ctx) => {
      const targetModelPattern = args?.trim() || "anthropic/claude-sonnet-4-6";
      
      // 1. Find the target model
      const targetModel = ctx.modelRegistry.find(targetModelPattern);
      const originalModel = ctx.model;

      if (!targetModel) {
        ctx.ui.notify(`Model ${targetModelPattern} not found. Using current model.`, "warning");
      } else if (targetModel.id !== originalModel.id) {
        // 2. Temporarily switch model
        ctx.ui.notify(`Switching to ${targetModelPattern} for consolidation...`, "info");
        const success = await pi.setModel(targetModel);
        if (!success) {
          ctx.ui.notify(`Failed to switch to ${targetModelPattern}. Using current model.`, "error");
        }
      }

      // 3. Trigger the synthesis
      pi.sendUserMessage(
        "Please review our current session and the project state. " +
        "Identify core architectural decisions, complex logic explanations, or important lessons learned. " +
        "Synthesize these into persistent project memories in `.pi/memory/`. " +
        "Update existing files if relevant, or create new ones for new topics. " +
        "Be concise and focus on information that would be valuable in a fresh session.", 
        { deliverAs: "followUp" }
      );
    }
  });

  // Lifecycle: Injected Context
  pi.on("before_agent_start", async (event, ctx) => {
    const projectDir = getProjectMemoryDir(ctx.cwd);
    const globalDir = getGlobalMemoryDir();
    const claudeMdPath = path.join(ctx.cwd, "CLAUDE.md");
    
    let memoryContext = "\n---\n### Project Context & Memory\n";
    let foundAny = false;

    // 1. CLAUDE.md - Match Claude Code behavior (Always inject if exists)
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, "utf8");
      memoryContext += `#### CLAUDE.md (Project Instructions):\n${content}\n\n`;
      foundAny = true;
    }

    // 2. Memory Map (Only names, not content)
    let memoryMap = "";
    if (fs.existsSync(projectDir)) {
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".md"));
      if (files.length > 0) {
        memoryMap += `Persistent Project Memories (.pi/memory/): ${files.join(", ")}\n`;
        foundAny = true;
      }
    }

    if (fs.existsSync(globalDir)) {
      const files = fs.readdirSync(globalDir).filter(f => f.endsWith(".md"));
      if (files.length > 0) {
        memoryMap += `Global Memories (~/.pi/agent/memory/): ${files.join(", ")}\n`;
        foundAny = true;
      }
    }

    if (memoryMap) {
      memoryContext += `#### Available Memory Files:\n${memoryMap}`;
      memoryContext += "To access these, use the `read_memory` tool. Do NOT assume you know their content until you read them.\n";
    }

    if (!foundAny) return;

    return {
      systemPrompt: event.systemPrompt + memoryContext
    };
  });
}
