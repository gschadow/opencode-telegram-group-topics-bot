import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../settings/manager.js";
import { getScopeFromContext, getScopeKeyFromContext, getThreadSendOptions } from "../scope.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

function statusEmoji(status: string): string {
  if (status === "connected") return "🟢";
  if (status === "disabled") return "⚫";
  if (status === "needs_auth" || status === "needs_client_registration") return "🔑";
  return "🔴";
}

export async function mcpsCommand(ctx: CommandContext<Context>) {
  const scope = getScopeFromContext(ctx);
  const scopeKey = getScopeKeyFromContext(ctx);
  const threadId = scope?.threadId ?? null;
  try {
    const currentProject = getCurrentProject(scopeKey);
    const params = currentProject ? { directory: currentProject.worktree } : undefined;
    const { data, error } = await opencodeClient.mcp.status(params);

    if (error || !data) {
      await ctx.reply(t("mcps.fetch_error"), getThreadSendOptions(threadId));
      return;
    }

    const entries = Object.entries(data);
    if (entries.length === 0) {
      await ctx.reply(t("mcps.empty"), getThreadSendOptions(threadId));
      return;
    }

    let message = t("mcps.header") + "\n\n";
    for (const [name, status] of entries) {
      message += `${statusEmoji(status.status)} ${name}: ${status.status}`;
      if ("error" in status && typeof status.error === "string") {
        message += `\n   ⚠️ ${status.error}`;
      }
      message += "\n";
    }

    await ctx.reply(message, getThreadSendOptions(threadId));
  } catch (error) {
    logger.error("[McpsCommand] Error listing MCP servers:", error);
    await ctx.reply(t("mcps.error"), getThreadSendOptions(threadId));
  }
}
