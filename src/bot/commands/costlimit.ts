import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../session/manager.js";
import { getScopeKeyFromContext } from "../scope.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { pinnedMessageManager } from "../../pinned/manager.js";

// The generated v2 SDK Session type omits `metadata`/`cost` even though the
// server returns them (packages/opencode/src/session/session.ts `Session.Info`).
interface SessionWithMeta {
  metadata?: Record<string, unknown>;
}

export async function costLimitCommand(ctx: CommandContext<Context>) {
  try {
    const scopeKey = getScopeKeyFromContext(ctx);
    const currentSession = getCurrentSession(scopeKey);

    if (!currentSession) {
      await ctx.reply(t("costlimit.no_session"));
      return;
    }

    const raw = ctx.match?.trim() ?? "";
    const limit = Number.parseFloat(raw);
    if (!Number.isFinite(limit) || limit <= 0) {
      await ctx.reply(t("costlimit.invalid"));
      return;
    }

    const { data } = await opencodeClient.session.get({
      sessionID: currentSession.id,
      directory: currentSession.directory,
    });
    const existing = (data as SessionWithMeta | undefined)?.metadata ?? {};

    // session.update is typed without `metadata`; cast like sessionCreateInDirectory.
    await opencodeClient.session.update({
      sessionID: currentSession.id,
      directory: currentSession.directory,
      metadata: { ...existing, budget: { maxCost: limit } },
    } as never);

    logger.info(
      `[CostLimit] Set budget maxCost=${limit} for session ${currentSession.id} (${currentSession.title})`,
    );
    await ctx.reply(t("costlimit.set", { limit: limit.toFixed(2) }));
    // Refresh the pinned panel so it shows the new cost limit.
    void pinnedMessageManager
      .loadContextFromHistory(currentSession.id, currentSession.directory, scopeKey)
      .catch(() => {});
  } catch (error) {
    logger.error("[CostLimit] Failed to set cost limit:", error);
    await ctx.reply(t("costlimit.error"));
  }
}