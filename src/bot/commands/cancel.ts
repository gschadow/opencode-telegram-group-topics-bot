import type { CommandContext, Context } from "grammy";
import { clearActiveInlineMenu } from "../handlers/inline-menu.js";
import { interactionManager } from "../../interaction/manager.js";
import { INTERACTION_CLEAR_REASON } from "../../interaction/constants.js";
import { questionManager } from "../../question/manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { getScopeKeyFromContext, getThreadSendOptions, getScopeFromContext } from "../scope.js";

/**
 * /cancel — dismiss any active inline menu or question modal without aborting
 * the current AI turn. Use /abort to also stop a running assistant response.
 */
export async function cancelCommand(ctx: CommandContext<Context>): Promise<void> {
  const scopeKey = getScopeKeyFromContext(ctx);
  const threadId = getScopeFromContext(ctx)?.threadId ?? null;
  const state = interactionManager.getSnapshot(scopeKey);

  if (!state) {
    await ctx.reply(t("interaction.blocked.expired"), getThreadSendOptions(threadId)).catch(() => {});
    return;
  }

  if (state.kind === "inline") {
    clearActiveInlineMenu(INTERACTION_CLEAR_REASON.MANUAL, scopeKey);
    logger.info(`[CancelCommand] Cleared inline menu for scope ${scopeKey}`);
    await ctx.reply("✖ Dismissed.", getThreadSendOptions(threadId)).catch(() => {});
    return;
  }

  if (state.kind === "question") {
    questionManager.clear(scopeKey);
    interactionManager.clear(INTERACTION_CLEAR_REASON.MANUAL, scopeKey);
    logger.info(`[CancelCommand] Cleared question modal for scope ${scopeKey}`);
    await ctx.reply("✖ Question dismissed.", getThreadSendOptions(threadId)).catch(() => {});
    return;
  }

  // Custom interactions (e.g. awaiting path input) and any other state
  interactionManager.clear(INTERACTION_CLEAR_REASON.MANUAL, scopeKey);
  logger.info(`[CancelCommand] Cleared ${state.kind} interaction for scope ${scopeKey}`);
  await ctx.reply("✖ Cancelled.", getThreadSendOptions(threadId)).catch(() => {});
}
