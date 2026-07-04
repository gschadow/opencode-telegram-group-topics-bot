import type { Api } from "grammy";
import { createMainKeyboard } from "../bot/utils/keyboard.js";
import type { ModelInfo } from "../model/types.js";
import { getStoredAgent } from "../agent/manager.js";
import { getStoredModel } from "../model/manager.js";
import { formatVariantForButton } from "../variant/manager.js";
import { logger } from "../utils/logger.js";
import type { ContextInfo, KeyboardState } from "./types.js";
import { t } from "../i18n/index.js";
import { SCOPE_CONTEXT, getScopeFromKey, getThreadIdFromScopeKey } from "../bot/scope.js";
import { contextStateManager } from "../context/manager.js";

class KeyboardManager {
  private stateByScope: Map<string, KeyboardState> = new Map();

  private api: Api | null = null;
  private chatId: number | null = null;
  private lastUpdateTimeByScope = new Map<string, number>();
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  private getOrCreateState(scopeKey: string): KeyboardState {
    const existing = this.stateByScope.get(scopeKey);
    if (existing) {
      return existing;
    }

    const currentModel = getStoredModel(scopeKey);
    const state: KeyboardState = {
      currentAgent: getStoredAgent(scopeKey),
      currentModel,
      contextInfo: null,
      variantName: formatVariantForButton(currentModel.variant || "default"),
    };

    this.stateByScope.set(scopeKey, state);
    return state;
  }

  public initialize(api: Api, chatId: number, scopeKey: string = "global"): void {
    this.api = api;
    this.chatId = chatId;

    const hadState = this.stateByScope.has(scopeKey);
    const state = this.getOrCreateState(scopeKey);

    if (!hadState) {
      logger.debug(
        `[KeyboardManager] Initialized scope=${scopeKey} agent="${state.currentAgent}", model="${state.currentModel.providerID}/${state.currentModel.modelID}", variant="${state.currentModel.variant || "default"}", chatId=${chatId}`,
      );
    }
  }

  public updateAgent(agent: string, scopeKey: string = "global"): void {
    const state = this.getOrCreateState(scopeKey);
    state.currentAgent = agent;
  }

  public updateModel(model: ModelInfo, scopeKey: string = "global"): void {
    const state = this.getOrCreateState(scopeKey);
    state.currentModel = model;
    state.variantName = formatVariantForButton(model.variant || "default");
  }

  public updateVariant(variantId: string, scopeKey: string = "global"): void {
    const state = this.getOrCreateState(scopeKey);
    state.variantName = formatVariantForButton(variantId);
  }

  public updateContext(tokensUsed: number, tokensLimit: number, scopeKey: string = "global"): void {
    contextStateManager.update(tokensUsed, tokensLimit, scopeKey);
  }

  public clearContext(scopeKey: string = "global"): void {
    contextStateManager.clear(scopeKey);
  }

  public getContextInfo(scopeKey: string = "global"): ContextInfo | null {
    return contextStateManager.get(scopeKey);
  }

  private buildKeyboard(scopeKey: string) {
    const state = this.getOrCreateState(scopeKey);
    const scope = getScopeFromKey(scopeKey);
    const effectiveContextInfo =
      scope?.context === SCOPE_CONTEXT.GROUP_GENERAL
        ? undefined
        : (contextStateManager.get(scopeKey) ?? undefined);
    const keyboardOptions =
      scope?.context === SCOPE_CONTEXT.GROUP_GENERAL
        ? {
            contextFirst: true,
            contextLabel: t("keyboard.general_defaults"),
          }
        : undefined;

    return createMainKeyboard(
      state.currentAgent,
      state.currentModel,
      effectiveContextInfo,
      state.variantName,
      keyboardOptions,
    );
  }

  public async sendKeyboardUpdate(_chatId?: number, _scopeKey: string = "global"): Promise<void> {
    // Reply keyboard removed; nothing to push
  }

  public getKeyboard(scopeKey: string = "global") {
    if (!this.stateByScope.has(scopeKey)) {
      return undefined;
    }

    return this.buildKeyboard(scopeKey);
  }

  public getState(scopeKey: string = "global"): KeyboardState | undefined {
    return this.stateByScope.get(scopeKey);
  }

  public isInitialized(scopeKey: string = "global"): boolean {
    return this.stateByScope.has(scopeKey);
  }
}

export const keyboardManager = new KeyboardManager();
