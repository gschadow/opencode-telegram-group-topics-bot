import { Context, InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { selectModel, fetchCurrentModel, getModelSelectionLists } from "../../model/manager.js";
import { formatModelForDisplay } from "../../model/types.js";
import type { FavoriteModel, ModelInfo, ModelSelectionLists } from "../../model/types.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { createMainKeyboard } from "../utils/keyboard.js";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import {
  appendInlineMenuCancelButton,
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "./inline-menu.js";
import { t } from "../../i18n/index.js";
import {
  SCOPE_CONTEXT,
  getScopeFromContext,
  getScopeFromKey,
  getScopeKeyFromContext,
  getThreadSendOptions,
} from "../scope.js";

const MODEL_CATALOG_PAGE_CALLBACK_PREFIX = "model:page:";
const MODEL_BROWSE_CALLBACK = "model:browse";
const MODEL_FAVORITES_CALLBACK = "model:favorites";
const MAX_INLINE_BUTTON_LABEL_LENGTH = 64;

interface CatalogModel {
  providerID: string;
  modelID: string;
}

interface ModelsPaginationRange {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

async function getCatalogModels(): Promise<CatalogModel[]> {
  const { data, error } = await opencodeClient.config.providers();

  if (error || !data) {
    throw error || new Error("No data received from server");
  }

  const models: CatalogModel[] = [];

  for (const provider of data.providers) {
    for (const modelID of Object.keys(provider.models)) {
      models.push({ providerID: provider.id, modelID });
    }
  }

  return models;
}

export function calculateModelsPaginationRange(
  totalModels: number,
  page: number,
  pageSize: number,
): ModelsPaginationRange {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalModels / safePageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalModels);

  return {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  };
}

export function parseModelPageCallback(data: string): number | null {
  if (!data.startsWith(MODEL_CATALOG_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPage = data.slice(MODEL_CATALOG_PAGE_CALLBACK_PREFIX.length);
  if (!/^\d+$/.test(rawPage)) {
    return null;
  }

  return Number.parseInt(rawPage, 10);
}

function formatCatalogModelButtonLabel(model: CatalogModel, isActive: boolean): string {
  const prefix = isActive ? "✅ " : "";
  const fullLabel = `${model.providerID}/${model.modelID}`;

  if (fullLabel.length <= MAX_INLINE_BUTTON_LABEL_LENGTH - prefix.length) {
    return `${prefix}${fullLabel}`;
  }

  return `${prefix}${fullLabel.slice(0, Math.max(0, MAX_INLINE_BUTTON_LABEL_LENGTH - prefix.length - 3))}...`;
}

function buildModelCatalogMenuText(page: number, totalPages: number): string {
  const baseText = t("model.menu.browse");

  if (totalPages <= 1) {
    return baseText;
  }

  return `${baseText}\n\n${t("model.menu.page_indicator", {
    current: String(page + 1),
    total: String(totalPages),
  })}`;
}

function buildModelCatalogKeyboard(
  catalogModels: CatalogModel[],
  page: number,
  currentModel?: ModelInfo,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const pageSize = config.bot.modelsListLimit;
  const {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  } = calculateModelsPaginationRange(catalogModels.length, page, pageSize);

  catalogModels.slice(startIndex, endIndex).forEach((model) => {
    const isActive =
      currentModel &&
      model.providerID === currentModel.providerID &&
      model.modelID === currentModel.modelID;
    const label = formatCatalogModelButtonLabel(model, Boolean(isActive));

    keyboard.text(label, `model:${model.providerID}:${model.modelID}`).row();
  });

  if (totalPages > 1) {
    if (normalizedPage > 0) {
      keyboard.text(
        t("model.button.prev_page"),
        `${MODEL_CATALOG_PAGE_CALLBACK_PREFIX}${normalizedPage - 1}`,
      );
    }

    if (normalizedPage < totalPages - 1) {
      keyboard.text(
        t("model.button.next_page"),
        `${MODEL_CATALOG_PAGE_CALLBACK_PREFIX}${normalizedPage + 1}`,
      );
    }

    keyboard.row();
  }

  keyboard.text(t("model.button.favorites"), MODEL_FAVORITES_CALLBACK).row();

  return keyboard;
}

async function handleCatalogPage(ctx: Context, page: number): Promise<void> {
  try {
    const scopeKey = getScopeKeyFromContext(ctx);
    const currentModel = fetchCurrentModel(scopeKey);
    const catalogModels = await getCatalogModels();

    if (catalogModels.length === 0) {
      await ctx.answerCallbackQuery({ text: t("model.page_empty_callback") });
      return;
    }

    const pageSize = config.bot.modelsListLimit;
    const {
      page: normalizedPage,
      totalPages,
      startIndex,
    } = calculateModelsPaginationRange(catalogModels.length, page, pageSize);

    if (startIndex >= catalogModels.length) {
      await ctx.answerCallbackQuery({ text: t("model.page_empty_callback") });
      return;
    }

    const keyboard = buildModelCatalogKeyboard(catalogModels, normalizedPage, currentModel);
    appendInlineMenuCancelButton(keyboard, "model");

    await ctx.editMessageText(buildModelCatalogMenuText(normalizedPage, totalPages), {
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  } catch (err) {
    logger.error("[ModelHandler] Error loading model catalog page:", err);
    await ctx.answerCallbackQuery({ text: t("model.page_load_error_callback") });
  }
}

async function openCatalogBrowser(ctx: Context): Promise<void> {
  try {
    const scopeKey = getScopeKeyFromContext(ctx);
    const currentModel = fetchCurrentModel(scopeKey);
    const catalogModels = await getCatalogModels();

    if (catalogModels.length === 0) {
      await ctx.answerCallbackQuery({ text: t("model.menu.browse_empty") });
      return;
    }

    const { totalPages } = calculateModelsPaginationRange(
      catalogModels.length,
      0,
      config.bot.modelsListLimit,
    );
    const keyboard = buildModelCatalogKeyboard(catalogModels, 0, currentModel);
    appendInlineMenuCancelButton(keyboard, "model");

    await ctx.editMessageText(buildModelCatalogMenuText(0, totalPages), {
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  } catch (err) {
    logger.error("[ModelHandler] Error opening model catalog:", err);
    await ctx.answerCallbackQuery({ text: t("model.browse_error") });
  }
}

async function showFavoritesMenu(ctx: Context): Promise<void> {
  try {
    const scopeKey = getScopeKeyFromContext(ctx);
    const currentModel = fetchCurrentModel(scopeKey);
    const { text, keyboard } = await buildFavoritesMenuView(currentModel);

    appendInlineMenuCancelButton(keyboard, "model");

    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  } catch (err) {
    logger.error("[ModelHandler] Error showing favorites menu:", err);
    await ctx.answerCallbackQuery({ text: t("model.menu.error") });
  }
}

function buildModelSelectionMenuText(modelLists: ModelSelectionLists): string {
  const lines = [t("model.menu.select"), t("model.menu.favorites_title")];

  if (modelLists.favorites.length === 0) {
    lines.push(t("model.menu.favorites_empty"));
  }

  lines.push(t("model.menu.recent_title"));

  if (modelLists.recent.length === 0) {
    lines.push(t("model.menu.recent_empty"));
  }

  return lines.join("\n");
}

/**
 * Handle model selection callback
 * @param ctx grammY context
 * @returns true if handled, false otherwise
 */
export async function handleModelSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || !callbackQuery.data.startsWith("model:")) {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "model");
  if (!isActiveMenu) {
    return true;
  }

  logger.debug(`[ModelHandler] Received callback: ${callbackQuery.data}`);

  try {
    const scopeKey = getScopeKeyFromContext(ctx);
    if (ctx.chat) {
      keyboardManager.initialize(ctx.api, ctx.chat.id, scopeKey);
    }

    const page = parseModelPageCallback(callbackQuery.data);
    if (page !== null) {
      await handleCatalogPage(ctx, page);
      return true;
    }

    if (callbackQuery.data === MODEL_BROWSE_CALLBACK) {
      await openCatalogBrowser(ctx);
      return true;
    }

    if (callbackQuery.data === MODEL_FAVORITES_CALLBACK) {
      await showFavoritesMenu(ctx);
      return true;
    }

    // Parse callback data: "model:providerID:modelID"
    const parts = callbackQuery.data.split(":");
    if (parts.length < 3) {
      logger.error(`[ModelHandler] Invalid callback data format: ${callbackQuery.data}`);
      clearActiveInlineMenu("model_select_invalid_callback", scopeKey);
      await ctx.answerCallbackQuery({ text: t("model.change_error_callback") }).catch(() => {});
      return true;
    }

    const providerID = parts[1];
    const modelID = parts.slice(2).join(":"); // Handle model IDs that may contain ":"

    const modelInfo: ModelInfo = {
      providerID,
      modelID,
      variant: "default", // Reset to default when switching models
    };

    // Select model and persist
    selectModel(modelInfo, scopeKey);

    // Update keyboard manager state (may not be initialized if no session selected)
    keyboardManager.updateModel(modelInfo, scopeKey);

    // Refresh context limit for new model
    await pinnedMessageManager.refreshContextLimit(scopeKey);

    // Update Reply Keyboard with new model and context
    const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
    const contextInfo =
      pinnedMessageManager.getContextInfo(scopeKey) ??
      (pinnedMessageManager.getContextLimit(scopeKey) > 0
        ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit(scopeKey) }
        : keyboardManager.getContextInfo(scopeKey));

    if (contextInfo) {
      keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit, scopeKey);
    }
    keyboardManager.updateAgent(currentAgent, scopeKey);

    const variantName = formatVariantForButton(modelInfo.variant || "default");
    const scope = getScopeFromKey(scopeKey);
    const keyboard = createMainKeyboard(
      currentAgent,
      modelInfo,
      contextInfo ?? undefined,
      variantName,
      scope?.context === SCOPE_CONTEXT.GROUP_GENERAL
        ? {
            contextFirst: true,
            contextLabel: t("keyboard.general_defaults"),
          }
        : undefined,
    );
    const displayName = formatModelForDisplay(modelInfo.providerID, modelInfo.modelID);
    const threadId = getScopeFromContext(ctx)?.threadId ?? null;

    clearActiveInlineMenu("model_selected", scopeKey);

    // Send confirmation message with updated keyboard
    await ctx.answerCallbackQuery({ text: t("model.changed_callback", { name: displayName }) });
    await ctx.reply(t("model.changed_message", { name: displayName }), {
      reply_markup: keyboard,
      ...getThreadSendOptions(threadId),
    });

    // Delete the inline menu message
    await ctx.deleteMessage().catch(() => {});

    return true;
  } catch (err) {
    clearActiveInlineMenu("model_select_error", getScopeKeyFromContext(ctx));
    logger.error("[ModelHandler] Error handling model select:", err);
    await ctx.answerCallbackQuery({ text: t("model.change_error_callback") }).catch(() => {});
    return false;
  }
}

/**
 * Build inline keyboard with favorite and recent models
 * @param currentModel Current model for highlighting
 * @returns InlineKeyboard with model selection buttons
 */
export async function buildModelSelectionMenu(
  currentModel?: ModelInfo,
  modelLists?: ModelSelectionLists,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const lists = modelLists ?? (await getModelSelectionLists());
  const favorites = lists.favorites;
  const recent = lists.recent;

  const addButton = (model: FavoriteModel, prefix: string): void => {
    const isActive =
      currentModel &&
      model.providerID === currentModel.providerID &&
      model.modelID === currentModel.modelID;

    // Inline buttons use full model ID without truncation
    const label = `${prefix} ${model.providerID}/${model.modelID}`;
    const labelWithCheck = isActive ? `✅ ${label}` : label;

    keyboard.text(labelWithCheck, `model:${model.providerID}:${model.modelID}`).row();
  };

  favorites.forEach((model) => addButton(model, "⭐"));
  recent.forEach((model) => addButton(model, "🕘"));

  keyboard.row().text(t("model.button.all_models"), MODEL_BROWSE_CALLBACK);

  return keyboard;
}

async function buildFavoritesMenuView(
  currentModel?: ModelInfo,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const modelLists = await getModelSelectionLists();
  const keyboard = await buildModelSelectionMenu(currentModel, modelLists);

  return {
    text: buildModelSelectionMenuText(modelLists),
    keyboard,
  };
}

/**
 * Show model selection menu
 * @param ctx grammY context
 */
export async function showModelSelectionMenu(ctx: Context): Promise<void> {
  try {
    const scopeKey = getScopeKeyFromContext(ctx);
    const currentModel = fetchCurrentModel(scopeKey);
    const { text, keyboard } = await buildFavoritesMenuView(currentModel);

    await replyWithInlineMenu(ctx, {
      menuKind: "model",
      text,
      keyboard,
    });
  } catch (err) {
    logger.error("[ModelHandler] Error showing model menu:", err);
    await ctx.reply(
      t("model.menu.error"),
      getThreadSendOptions(getScopeFromContext(ctx)?.threadId ?? null),
    );
  }
}
