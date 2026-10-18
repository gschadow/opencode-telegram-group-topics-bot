import { access } from "node:fs/promises";
import { Bot, Context } from "grammy";
import type { FilePartInput, TextPartInput } from "../../opencode/v1-types.js";
import { opencodeClient, sessionCreateInDirectory } from "../../opencode/client.js";
import { classifyPromptSubmitError } from "../../opencode/prompt-submit-error.js";
import { clearSession, getCurrentSession, setCurrentSession } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { isTtsEnabled } from "../../settings/manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { createMainKeyboard } from "../utils/keyboard.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { interactionManager } from "../../interaction/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import {
  GLOBAL_SCOPE_KEY,
  SCOPE_CONTEXT,
  getScopeFromContext,
  getThreadSendOptions,
} from "../scope.js";
import { BOT_I18N_KEY, CHAT_TYPE } from "../constants.js";
import { INTERACTION_CLEAR_REASON } from "../../interaction/constants.js";
import { getTopicBindingByScopeKey } from "../../topic/manager.js";
import { getScheduledTaskTopicByChatAndThread } from "../../scheduled-task/store.js";
import { assistantRunState } from "../assistant-run-state.js";
import { buildSenderOriginHeader } from "../utils/sender-origin.js";

/** Module-level references for async callbacks that don't have ctx. */
let botInstance: Bot<Context> | null = null;
let chatIdInstance: number | null = null;

type PromptRequestOptions = {
  sessionID: string;
  directory: string;
  parts: Array<TextPartInput | FilePartInput>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
};

export type PromptResponseMode = "text_only" | "text_and_tts";

type ProcessPromptOptions = {
  responseMode?: PromptResponseMode;
};

type PromptErrorLogContext = {
  sessionId: string;
  directory: string;
  agent: string;
  modelProvider: string;
  modelId: string;
  variant: string;
  promptLength: number;
  fileCount: number;
};

const activePromptResponseModes = new Map<string, PromptResponseMode>();

export function getPromptBotInstance(): Bot<Context> | null {
  return botInstance;
}

export function getPromptChatId(): number | null {
  return chatIdInstance;
}

function buildPromptRequest(
  currentSession: { id: string; directory: string },
  currentAgent: string | null,
  storedModel: { providerID?: string | null; modelID?: string | null; variant?: string | null },
  text: string,
  fileParts: FilePartInput[],
): { promptOptions: PromptRequestOptions; promptErrorLogContext: PromptErrorLogContext } {
  const parts: Array<TextPartInput | FilePartInput> = [];

  if (text.trim().length > 0) {
    parts.push({ type: "text", text });
  }

  parts.push(...fileParts);

  if (parts.length === 0 || (parts.length > 0 && parts.every((part) => part.type === "file"))) {
    if (fileParts.length > 0) {
      parts.unshift({ type: "text", text: "See attached file" });
    }
  }

  const promptOptions: PromptRequestOptions = {
    sessionID: currentSession.id,
    directory: currentSession.directory,
    parts,
    agent: currentAgent ?? undefined,
  };

  if (storedModel.providerID && storedModel.modelID) {
    promptOptions.model = {
      providerID: storedModel.providerID,
      modelID: storedModel.modelID,
    };

    if (storedModel.variant) {
      promptOptions.variant = storedModel.variant;
    }
  }

  return {
    promptOptions,
    promptErrorLogContext: {
      sessionId: currentSession.id,
      directory: currentSession.directory,
      agent: currentAgent || "default",
      modelProvider: storedModel.providerID || "default",
      modelId: storedModel.modelID || "default",
      variant: storedModel.variant || "default",
      promptLength: text.length,
      fileCount: fileParts.length,
    },
  };
}

function setActivePromptResponseMode(sessionId: string, responseMode: PromptResponseMode): void {
  activePromptResponseModes.set(sessionId, responseMode);
}

export function getDefaultPromptResponseMode(): PromptResponseMode {
  return isTtsEnabled() ? "text_and_tts" : "text_only";
}

export function activatePromptResponseMode(
  sessionId: string,
  responseMode: PromptResponseMode,
): void {
  setActivePromptResponseMode(sessionId, responseMode);
}

export function clearPromptResponseMode(sessionId: string): void {
  activePromptResponseModes.delete(sessionId);
}

export function consumePromptResponseMode(sessionId: string): PromptResponseMode | null {
  const responseMode = activePromptResponseModes.get(sessionId) ?? null;
  activePromptResponseModes.delete(sessionId);
  return responseMode;
}

function submitPromptRequest(
  bot: Bot<Context>,
  sessionId: string,
  chatId: number,
  threadId: number | null,
  responseMode: PromptResponseMode,
  promptOptions: PromptRequestOptions,
  promptErrorLogContext: PromptErrorLogContext,
): void {
  setActivePromptResponseMode(sessionId, responseMode);
  assistantRunState.startRun(sessionId, {
    startedAt: Date.now(),
    configuredAgent: promptOptions.agent,
    configuredProviderID: promptOptions.model?.providerID,
    configuredModelID: promptOptions.model?.modelID,
  });

  logger.info(
    `[Bot] Calling session.promptAsync (fire-and-forget) with agent=${promptOptions.agent}, fileCount=${promptErrorLogContext.fileCount}...`,
  );

  safeBackgroundTask({
    taskName: "session.promptAsync",
    task: () => opencodeClient.session.promptAsync(promptOptions),
    onSuccess: ({ error }) => {
      if (!error) {
        logger.info("[Bot] session.promptAsync accepted");
        return;
      }

      const details = formatErrorDetails(error, 6000);
      const errorType = classifyPromptSubmitError(error);
      logger.error("[Bot] OpenCode API returned an error for session.promptAsync", promptErrorLogContext);
      logger.error("[Bot] session.promptAsync error details:", details);
      logger.error("[Bot] session.promptAsync raw API error object:", error);

      const errorMessageKey =
        errorType === "session_not_found"
          ? "bot.prompt_send_error_session_not_found"
          : "bot.prompt_send_error";

      assistantRunState.clearRun(sessionId, "prompt_submit_error");

      void bot.api
        .sendMessage(chatId, t(errorMessageKey), {
          ...getThreadSendOptions(threadId),
        })
        .catch(() => {});
    },
    onError: (error) => {
      const details = formatErrorDetails(error, 6000);
      const errorType = classifyPromptSubmitError(error);
      logger.error("[Bot] session.promptAsync background task failed", promptErrorLogContext);
      logger.error("[Bot] session.promptAsync background failure details:", details);
      logger.error("[Bot] session.promptAsync raw background error object:", error);

      const errorMessageKey =
        errorType === "session_not_found"
          ? "bot.prompt_send_error_session_not_found"
          : "bot.prompt_send_error";

      clearPromptResponseMode(sessionId);
      assistantRunState.clearRun(sessionId, "prompt_submit_background_error");

      void bot.api
        .sendMessage(chatId, t(errorMessageKey), {
          ...getThreadSendOptions(threadId),
        })
        .catch(() => {});
    },
  });
}

async function projectDirectoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

function resetMismatchedSessionContextForScope(scopeKey: string): void {
  clearAllInteractionState(INTERACTION_CLEAR_REASON.SESSION_MISMATCH_RESET, scopeKey);
  clearSession(scopeKey);
}

export interface ProcessPromptDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
  prepareSessionForPrompt?: (sessionId: string) => Promise<void>;
}

/**
 * Processes a user prompt: ensures project/session, subscribes to events, and sends
 * the prompt to OpenCode. Used by text, voice, and photo message handlers.
 *
 * @param ctx - Grammy context
 * @param text - Text content of the prompt
 * @param deps - Dependencies (bot and event subscription)
 * @param fileParts - Optional file parts (for photo/document attachments)
 * @returns true if the prompt was dispatched, false if it was blocked/failed early.
 */
export async function processUserPrompt(
  ctx: Context,
  text: string,
  deps: ProcessPromptDeps,
  fileParts: FilePartInput[] = [],
  options: ProcessPromptOptions = {},
): Promise<boolean> {
  const { bot, ensureEventSubscription, prepareSessionForPrompt } = deps;
  const scope = getScopeFromContext(ctx);
  const responseMode = options.responseMode ?? getDefaultPromptResponseMode();
  const scopeKey = scope?.key ?? GLOBAL_SCOPE_KEY;
  const usePinned = ctx.chat?.type !== CHAT_TYPE.PRIVATE;

  if (
    scope?.context === SCOPE_CONTEXT.GROUP_TOPIC &&
    ctx.chat &&
    typeof scope.threadId === "number" &&
    (await getScheduledTaskTopicByChatAndThread(ctx.chat.id, scope.threadId))
  ) {
    await ctx.reply(t("task.output_topic_blocked"), getThreadSendOptions(scope.threadId));
    return false;
  }

  const currentProject = getCurrentProject(scopeKey);
  if (!currentProject) {
    await ctx.reply(t("bot.project_not_selected"));
    return false;
  }

  if (
    scope?.context === SCOPE_CONTEXT.GROUP_TOPIC &&
    currentProject.id.includes(":") &&
    !(await projectDirectoryExists(currentProject.worktree))
  ) {
    await ctx.reply(t("topic.worktree_missing"), getThreadSendOptions(scope.threadId));
    return false;
  }

  botInstance = bot;
  chatIdInstance = ctx.chat!.id;

  // Initialize pinned message manager if not already
  if (usePinned && !pinnedMessageManager.isInitialized(scopeKey)) {
    pinnedMessageManager.initialize(bot.api, ctx.chat!.id, scopeKey, scope?.threadId ?? null);
  }

  // Initialize keyboard manager if not already
  keyboardManager.initialize(bot.api, ctx.chat!.id, scopeKey);

  let currentSession = getCurrentSession(scopeKey);

  if (scope?.context === SCOPE_CONTEXT.GROUP_TOPIC && !getTopicBindingByScopeKey(scopeKey)) {
    await ctx.reply(t(BOT_I18N_KEY.TOPIC_UNBOUND), getThreadSendOptions(scope.threadId));
    return false;
  }

  if (currentSession && currentSession.directory !== currentProject.worktree) {
    logger.warn(
      `[Bot] Session/project mismatch detected. sessionDirectory=${currentSession.directory}, projectDirectory=${currentProject.worktree}. Resetting session context.`,
    );
    resetMismatchedSessionContextForScope(scopeKey);
    await ctx.reply(t("bot.session_reset_project_mismatch"));
    return false;
  }

  if (!currentSession) {
    if (scope?.context === SCOPE_CONTEXT.GROUP_TOPIC) {
      await ctx.reply(t(BOT_I18N_KEY.TOPIC_UNBOUND), getThreadSendOptions(scope.threadId));
      return false;
    }

    await ctx.reply(t("bot.creating_session"));

    const { data: session, error } = await sessionCreateInDirectory(currentProject.worktree);

    if (error || !session) {
      await ctx.reply(t("bot.create_session_error"));
      return false;
    }

    logger.info(
      `[Bot] Created new session: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    currentSession = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };

    setCurrentSession(currentSession, scopeKey);
    await ingestSessionInfoForCache(session);

    // Create pinned message for new session
    if (usePinned) {
      try {
        await pinnedMessageManager.onSessionChange(session.id, session.title, scopeKey);
      } catch (err) {
        logger.error("[Bot] Error creating pinned message for new session:", err);
      }
    }

    if (usePinned && pinnedMessageManager.getContextLimit(scopeKey) === 0) {
      await pinnedMessageManager.refreshContextLimit(scopeKey);
    }

    const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
    const currentModel = getStoredModel(scopeKey);
    const contextInfo =
      (usePinned ? pinnedMessageManager.getContextInfo(scopeKey) : null) ??
      keyboardManager.getContextInfo(scopeKey) ??
      (usePinned && pinnedMessageManager.getContextLimit(scopeKey) > 0
        ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit(scopeKey) }
        : null);
    const variantName = formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(
      currentAgent,
      currentModel,
      contextInfo ?? undefined,
      variantName,
    );

    await ctx.reply(t("bot.session_created", { title: session.title }), {
      reply_markup: keyboard,
    });
  } else {
    logger.info(
      `[Bot] Using existing session: id=${currentSession.id}, title="${currentSession.title}"`,
    );

    // Ensure pinned message exists for existing session
    if (usePinned && !pinnedMessageManager.getState(scopeKey).messageId) {
      try {
        await pinnedMessageManager.onSessionChange(
          currentSession.id,
          currentSession.title,
          scopeKey,
        );
      } catch (err) {
        logger.error("[Bot] Error creating pinned message for existing session:", err);
      }
    }
  }

  await ensureEventSubscription(currentSession.directory);

  summaryAggregator.setSession(currentSession.id);

  try {
    const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
    const storedModel = getStoredModel(scopeKey);
    if (prepareSessionForPrompt) {
      await prepareSessionForPrompt(currentSession.id);
    }

    const originHeader = buildSenderOriginHeader(ctx);
    const textWithOrigin = originHeader ? `${originHeader}\n\n${text}` : text;
    const request = buildPromptRequest(
      currentSession,
      currentAgent,
      storedModel,
      textWithOrigin,
      fileParts,
    );
    submitPromptRequest(
      bot,
      currentSession.id,
      ctx.chat!.id,
      scope?.threadId ?? null,
      responseMode,
      request.promptOptions,
      request.promptErrorLogContext,
    );

    return true;
  } catch (err) {
    logger.error("Error in prompt handler:", err);
    if (interactionManager.getSnapshot(scopeKey)) {
      clearAllInteractionState(INTERACTION_CLEAR_REASON.MESSAGE_HANDLER_ERROR, scopeKey);
    }
    await ctx.reply(t("error.generic"));
    return false;
  }
}
