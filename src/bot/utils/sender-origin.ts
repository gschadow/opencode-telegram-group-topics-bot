import type { Context } from "grammy";
import { CHAT_TYPE } from "../constants.js";
import { getScopeFromContext } from "../scope.js";

/**
 * Builds a compact origin header that identifies who is speaking and from which
 * Telegram chat/thread the prompt originates. It is prepended to the user text
 * so the OpenCode session always knows the speaker and the group it must reply
 * to (chat id + thread id are included so file responses can be routed back).
 *
 * Returns an empty string when the context carries no sender/chat information.
 */
export function buildSenderOriginHeader(ctx: Context): string {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) {
    return "";
  }

  const name = buildDisplayName(from);
  const scope = getScopeFromContext(ctx);
  const threadId = scope?.threadId ?? null;

  const groupLabel =
    chat.type === CHAT_TYPE.PRIVATE ? "private chat" : `group "${getChatTitle(chat)}"`;

  const parts: string[] = [`[Telegram] ${name} says through ${groupLabel}`];
  parts.push(`chat id ${chat.id}`);
  if (threadId !== null && threadId !== 1) {
    parts.push(`thread ${threadId}`);
  }

  return `${parts.join(", ")}:`;
}

function buildDisplayName(from: {
  first_name?: string;
  last_name?: string;
  username?: string;
  id: number;
}): string {
  const givenName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (givenName) {
    return from.username ? `${givenName} (@${from.username})` : givenName;
  }
  return from.username ? `@${from.username}` : `user ${from.id}`;
}

function getChatTitle(chat: { id: number; type: string; title?: string }): string {
  return chat.title ?? String(chat.id);
}