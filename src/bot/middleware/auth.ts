import { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, allowedUserId=${config.telegram.allowedUserId}, chatType=${ctx.chat?.type}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (userId && userId === config.telegram.allowedUserId) {
    logger.debug(`[Auth] Access granted for owner userId=${userId}`);
    await next();
    return;
  }

  // Allow any user in group/supergroup chats (multi-user groups)
  if (ctx.chat && GROUP_CHAT_TYPES.has(ctx.chat.type)) {
    logger.debug(`[Auth] Access granted for non-owner userId=${userId} in group chat`);
    await next();
    return;
  }

  // Silently ignore unauthorized users in private chats
  logger.warn(`Unauthorized access attempt from user ID: ${userId} in private chat`);

  // Actively hide commands for unauthorized users by setting empty command list
  if (ctx.chat?.id && ctx.chat.id !== config.telegram.allowedUserId) {
    try {
      await ctx.api.setMyCommands([], {
        scope: { type: "chat", chat_id: ctx.chat.id },
      });
      logger.debug(`[Auth] Set empty commands for unauthorized chat_id=${ctx.chat.id}`);
    } catch (err) {
      logger.debug(`[Auth] Could not set empty commands: ${err}`);
    }
  }
}
