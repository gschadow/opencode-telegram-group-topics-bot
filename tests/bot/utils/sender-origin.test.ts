import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  getScopeFromContextMock: vi.fn(),
}));

vi.mock("../../../src/bot/scope.js", () => ({
  getScopeFromContext: mocked.getScopeFromContextMock,
}));

import { buildSenderOriginHeader } from "../../../src/bot/utils/sender-origin.js";

function makeContext(overrides: Record<string, unknown>): Context {
  return {
    chat: { id: -100123, type: "supergroup", title: "Test Group" },
    from: { id: 42, first_name: "Gunther", last_name: "Schadow", username: "gschadow" },
    message: { text: "Hello", message_thread_id: 555 },
    ...overrides,
  } as unknown as Context;
}

describe("bot/utils/sender-origin", () => {
  it("builds a group-topic header with chat id and thread", () => {
    mocked.getScopeFromContextMock.mockReturnValue({
      key: "-100123:555",
      chatId: -100123,
      threadId: 555,
      context: "group-topic",
    });

    const header = buildSenderOriginHeader(
      makeContext({ message: { text: "Hello", message_thread_id: 555 } }),
    );

    expect(header).toBe(
      '[Telegram] Gunther Schadow (@gschadow) says through group "Test Group", chat id -100123, thread 555:',
    );
  });

  it("omits the thread for the general topic (thread 1) and group-general scope", () => {
    mocked.getScopeFromContextMock.mockReturnValue({
      key: "chat:-100123",
      chatId: -100123,
      threadId: null,
      context: "group-general",
    });

    const header = buildSenderOriginHeader(
      makeContext({ message: { text: "Hello", message_thread_id: 1 } }),
    );

    expect(header).toBe(
      '[Telegram] Gunther Schadow (@gschadow) says through group "Test Group", chat id -100123:',
    );
  });

  it("labels private chats and falls back to username or user id", () => {
    mocked.getScopeFromContextMock.mockReturnValue({
      key: "dm:7380128754",
      chatId: 7380128754,
      threadId: null,
      context: "dm",
    });

    const header = buildSenderOriginHeader(
      makeContext({
        chat: { id: 7380128754, type: "private" },
        from: { id: 7380128754, username: "gunther" },
        message: { text: "Hi" },
      }),
    );

    expect(header).toBe(
      "[Telegram] @gunther says through private chat, chat id 7380128754:",
    );

    const noUsername = buildSenderOriginHeader(
      makeContext({
        chat: { id: 7380128754, type: "private" },
        from: { id: 7380128754 },
        message: { text: "Hi" },
      }),
    );

    expect(noUsername).toBe("[Telegram] user 7380128754 says through private chat, chat id 7380128754:");
  });

  it("returns an empty string when sender or chat is missing", () => {
    mocked.getScopeFromContextMock.mockReturnValue(null);

    const noFrom = makeContext({ from: undefined });
    expect(buildSenderOriginHeader(noFrom)).toBe("");

    const noChat = makeContext({ chat: undefined });
    expect(buildSenderOriginHeader(noChat)).toBe("");
  });
});