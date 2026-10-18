import { Context } from "grammy";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { GLOBAL_SCOPE_KEY, getScopeFromContext } from "../scope.js";
import { logger } from "../../utils/logger.js";

export interface PromptCoalescerOptions {
  windowMs: number;
  minLength: number;
}

interface PendingPrompt {
  ctx: Context;
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
}

const pendingPrompts = new Map<string, PendingPrompt>();

function flushCoalescedPrompt(scopeKey: string, deps: ProcessPromptDeps): void {
  const pending = pendingPrompts.get(scopeKey);
  if (!pending) {
    return;
  }

  pendingPrompts.delete(scopeKey);
  clearTimeout(pending.timer);

  const combinedText = pending.texts.join("\n\n");
  logger.debug("[PromptCoalescer] Flushing coalesced prompt", {
    scopeKey,
    messageCount: pending.texts.length,
    textLength: combinedText.length,
  });
  void processUserPrompt(pending.ctx, combinedText, deps);
}

/**
 * Coalesces rapid consecutive user text messages into a single prompt. Telegram
 * splits pastes longer than 4096 chars into multiple messages; this merges those
 * parts back into one prompt so the agent receives the full text as one input.
 *
 * Messages shorter than `minLength` are submitted immediately (no added latency).
 * When a long message arrives - or a coalescing window is already open - subsequent
 * messages from the same scope are buffered until `windowMs` of quiet elapses.
 */
export function queueCoalescedPrompt(
  ctx: Context,
  text: string,
  deps: ProcessPromptDeps,
  options: PromptCoalescerOptions,
): void {
  const scopeKey = getScopeFromContext(ctx)?.key ?? GLOBAL_SCOPE_KEY;
  const existing = pendingPrompts.get(scopeKey);
  if (existing) {
    existing.texts.push(text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushCoalescedPrompt(scopeKey, deps), options.windowMs);
    return;
  }

  if (text.length >= options.minLength) {
    const timer = setTimeout(() => flushCoalescedPrompt(scopeKey, deps), options.windowMs);
    pendingPrompts.set(scopeKey, { ctx, texts: [text], timer });
    return;
  }

  void processUserPrompt(ctx, text, deps);
}

export function __resetPromptCoalescerForTests(): void {
  for (const pending of pendingPrompts.values()) {
    clearTimeout(pending.timer);
  }
  pendingPrompts.clear();
}