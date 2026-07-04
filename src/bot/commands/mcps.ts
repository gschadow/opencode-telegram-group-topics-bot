import { CommandContext, Context, InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../settings/manager.js";
import {
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "../handlers/inline-menu.js";
import { getScopeFromContext, getScopeKeyFromContext, getThreadSendOptions } from "../scope.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

const MCP_CONNECT_PREFIX = "mcp:connect:";
const MCP_DISCONNECT_PREFIX = "mcp:disconnect:";

type McpStatusValue = { status: string; error?: string };

function statusEmoji(status: string): string {
  if (status === "connected") return "🟢";
  if (status === "disabled") return "⚫";
  if (status === "needs_auth" || status === "needs_client_registration") return "🔑";
  return "🔴";
}

function canToggle(status: string): boolean {
  return status !== "needs_auth" && status !== "needs_client_registration";
}

function buildMcpsMenu(entries: [string, McpStatusValue][]): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const keyboard = new InlineKeyboard();
  let text = t("mcps.header") + "\n\n";

  for (const [name, status] of entries) {
    text += `${statusEmoji(status.status)} ${name}: ${status.status}`;
    if (status.error) {
      text += `\n   ⚠️ ${status.error}`;
    }
    text += "\n";

    if (canToggle(status.status)) {
      const isConnected = status.status === "connected";
      const label = isConnected ? t("mcps.button.disconnect", { name }) : t("mcps.button.connect", { name });
      const callbackData = isConnected
        ? `${MCP_DISCONNECT_PREFIX}${name}`
        : `${MCP_CONNECT_PREFIX}${name}`;
      keyboard.text(label, callbackData).row();
    }
  }

  return { text, keyboard };
}

async function fetchMcpEntries(scopeKey: string): Promise<[string, McpStatusValue][] | null> {
  const currentProject = getCurrentProject(scopeKey);
  const params = currentProject ? { directory: currentProject.worktree } : undefined;
  const { data, error } = await opencodeClient.mcp.status(params);
  if (error || !data) return null;
  return Object.entries(data) as [string, McpStatusValue][];
}

export async function mcpsCommand(ctx: CommandContext<Context>) {
  const scope = getScopeFromContext(ctx);
  const scopeKey = getScopeKeyFromContext(ctx);
  const threadId = scope?.threadId ?? null;
  try {
    const entries = await fetchMcpEntries(scopeKey);
    if (!entries) {
      await ctx.reply(t("mcps.fetch_error"), getThreadSendOptions(threadId));
      return;
    }
    if (entries.length === 0) {
      await ctx.reply(t("mcps.empty"), getThreadSendOptions(threadId));
      return;
    }

    const { text, keyboard } = buildMcpsMenu(entries);
    await replyWithInlineMenu(ctx, { menuKind: "mcp", text, keyboard });
  } catch (error) {
    logger.error("[McpsCommand] Error listing MCP servers:", error);
    await ctx.reply(t("mcps.error"), getThreadSendOptions(threadId));
  }
}

export async function handleMcpsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || (!data.startsWith(MCP_CONNECT_PREFIX) && !data.startsWith(MCP_DISCONNECT_PREFIX))) {
    return false;
  }

  const scopeKey = getScopeKeyFromContext(ctx);
  const isConnect = data.startsWith(MCP_CONNECT_PREFIX);
  const name = data.slice(isConnect ? MCP_CONNECT_PREFIX.length : MCP_DISCONNECT_PREFIX.length);

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "mcp");
  if (!isActiveMenu) return true;

  try {
    const currentProject = getCurrentProject(scopeKey);
    const params = { name, ...(currentProject ? { directory: currentProject.worktree } : {}) };

    if (isConnect) {
      const { error } = await opencodeClient.mcp.connect(params);
      if (error) {
        await ctx.answerCallbackQuery({ text: t("mcps.connect_error", { name }), show_alert: true });
        return true;
      }
    } else {
      const { error } = await opencodeClient.mcp.disconnect(params);
      if (error) {
        await ctx.answerCallbackQuery({ text: t("mcps.disconnect_error", { name }), show_alert: true });
        return true;
      }
    }

    // Refresh the menu with updated status
    const entries = await fetchMcpEntries(scopeKey);
    if (!entries) {
      await ctx.answerCallbackQuery({ text: t("mcps.fetch_error"), show_alert: true });
      return true;
    }

    const { text, keyboard } = buildMcpsMenu(entries);
    const { appendInlineMenuCancelButton } = await import("../handlers/inline-menu.js");
    await ctx.editMessageText(text, { reply_markup: appendInlineMenuCancelButton(keyboard, "mcp") });
    await ctx.answerCallbackQuery({ text: isConnect ? t("mcps.connected", { name }) : t("mcps.disconnected", { name }) });
  } catch (error) {
    logger.error("[McpsCommand] Error toggling MCP server:", error);
    clearActiveInlineMenu("mcp_toggle_error", scopeKey);
    await ctx.answerCallbackQuery({ text: t("mcps.error"), show_alert: true });
  }

  return true;
}
