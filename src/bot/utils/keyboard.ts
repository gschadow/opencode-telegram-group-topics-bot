import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../agent/types.js";
import { formatModelForButton } from "../../model/types.js";
import type { ModelInfo } from "../../model/types.js";
import type { ContextInfo } from "../../keyboard/types.js";
import { t } from "../../i18n/index.js";

interface MainKeyboardOptions {
  contextFirst?: boolean;
  contextLabel?: string;
}

/**
 * Format token count for display (e.g., 150000 -> "150K", 1500000 -> "1.5M")
 */
function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  } else if (count >= 1000) {
    return `${Math.round(count / 1000)}K`;
  }
  return count.toString();
}

/**
 * Format context information for button
 */
export function formatContextForButton(contextInfo: ContextInfo): string {
  const used = formatTokenCount(contextInfo.tokensUsed);
  const limit = formatTokenCount(contextInfo.tokensLimit);
  const percent = Math.round((contextInfo.tokensUsed / contextInfo.tokensLimit) * 100);
  return t("keyboard.context", { used, limit, percent });
}

/**
 * Create Reply Keyboard with agent, model, variant, and context indicators
 * @param currentAgent Current agent name (e.g., "build", "plan")
 * @param currentModel Current model info
 * @param contextInfo Optional context information (tokens used/limit)
 * @param variantName Optional variant display name (e.g., "💭 Default")
 * @returns Reply Keyboard with agent and context in row 1, model and variant in row 2
 */
export function createMainKeyboard(
  _currentAgent?: string,
  _currentModel?: ModelInfo,
  _contextInfo?: ContextInfo,
  _variantName?: string,
  _options?: MainKeyboardOptions,
): { remove_keyboard: true } {
  return removeKeyboard();
}

export function createDmKeyboard(): Keyboard {
  return new Keyboard()
    .text(t("keyboard.dm.status"))
    .text(t("keyboard.dm.help"))
    .row()
    .text(t("keyboard.dm.opencode_start"))
    .text(t("keyboard.dm.opencode_stop"))
    .row()
    .resized()
    .persistent();
}

/**
 * Create Reply Keyboard with agent indicator
 * @param currentAgent Current agent name (e.g., "build", "plan")
 * @returns Reply Keyboard with single button showing current agent
 * @deprecated Use createMainKeyboard instead
 */
export function createAgentKeyboard(currentAgent: string): Keyboard {
  const keyboard = new Keyboard();
  const displayName = getAgentButtonLabel(currentAgent);

  // Single button with current agent
  keyboard.text(displayName).row();

  return keyboard.resized().persistent();
}

/**
 * Remove Reply Keyboard (for cleanup)
 */
export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}
