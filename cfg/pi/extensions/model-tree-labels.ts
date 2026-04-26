import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function modelTreeLabels(pi: ExtensionAPI) {
  const modelTag = (provider: string, id: string) => `m:${provider}/${id}`;

  const upsertModelTag = (ctx: any, entryId: string, provider: string, modelId: string) => {
    const tag = modelTag(provider, modelId);
    const existing = ctx.sessionManager.getLabel(entryId);

    // Replace any previous model tag, preserve other label text
    if (existing && existing.length > 0) {
      const parts = existing
        .split(" | ")
        .map((p: string) => p.trim())
        .filter(Boolean)
        .filter((p: string) => !p.startsWith("m:"));
      parts.push(tag);
      pi.setLabel(entryId, parts.join(" | "));
      return;
    }

    pi.setLabel(entryId, tag);
  };

  // Keep label on current leaf in sync whenever model changes
  pi.on("model_select", async (event, ctx) => {
    const leafId = ctx.sessionManager.getLeafId?.();
    if (!leafId) return;
    upsertModelTag(ctx, leafId, event.model.provider, event.model.id);
  });

  // After /tree navigation, ensure new leaf and summary entry (if any) carry model tag
  pi.on("session_tree", async (event, ctx) => {
    if (!ctx.model) return;

    if (event.newLeafId) {
      upsertModelTag(ctx, event.newLeafId, ctx.model.provider, ctx.model.id);
    }

    if (event.summaryEntry?.id) {
      const base = `branch-from:${event.oldLeafId ?? "root"}`;
      const existing = ctx.sessionManager.getLabel(event.summaryEntry.id);
      const textOnly = (existing || "")
        .split(" | ")
        .map((p: string) => p.trim())
        .filter(Boolean)
        .filter((p: string) => !p.startsWith("m:") && !p.startsWith("branch-from:"));
      const merged = [base, ...textOnly, modelTag(ctx.model.provider, ctx.model.id)].join(" | ");
      pi.setLabel(event.summaryEntry.id, merged);
    }
  });

  // Manual bookmark command: /mark <optional text>
  pi.registerCommand("mark", {
    description: "Label current leaf with optional text and active model",
    handler: async (args, ctx) => {
      const leafId = ctx.sessionManager.getLeafId?.();
      if (!leafId || !ctx.model) return;

      const existing = ctx.sessionManager.getLabel(leafId);
      const nonModel = (existing || "")
        .split(" | ")
        .map((p: string) => p.trim())
        .filter(Boolean)
        .filter((p: string) => !p.startsWith("m:"));

      const userText = args?.trim();
      const withoutDup = userText
        ? [userText, ...nonModel.filter((p: string) => p !== userText)]
        : nonModel;

      const label = [...withoutDup, modelTag(ctx.model.provider, ctx.model.id)].join(" | ");
      pi.setLabel(leafId, label);
      ctx.ui.notify(`Labeled ${leafId}: ${label}`, "success");
    },
  });
}
