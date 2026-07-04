import type { Context, NextFunction } from "grammy";
import { extractCommandName, isKnownCommand } from "../utils/commands.js";
import { interactionManager } from "../../interaction/manager.js";
import { getScopeKeyFromContext } from "../scope.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export async function unknownCommandMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const text = ctx.message?.text;
  if (!text) {
    await next();
    return;
  }

  const commandName = extractCommandName(text);
  if (!commandName) {
    await next();
    return;
  }

  if (isKnownCommand(commandName)) {
    await next();
    return;
  }

  // If the active interaction expects free-text (e.g. awaiting a path), pass
  // the message through so the text handler can process it.  Unix paths start
  // with "/" which Telegram parses as a command token, but the full text is
  // still available to the text handler via ctx.message.text.
  const scopeKey = getScopeKeyFromContext(ctx);
  const state = interactionManager.getSnapshot(scopeKey);
  if (state?.expectedInput === "text") {
    await next();
    return;
  }

  const commandToken = text.trim().split(/\s+/)[0];
  logger.debug(`[Bot] Unknown slash command received: ${commandToken}`);
  await ctx.reply(t("bot.unknown_command", { command: commandToken }));
}
