import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  __resetPromptCoalescerForTests,
  queueCoalescedPrompt,
} from "../../../src/bot/handlers/prompt-coalescer.js";
import { GLOBAL_SCOPE_KEY } from "../../../src/bot/scope.js";

const mocked = vi.hoisted(() => ({
  processUserPromptMock: vi.fn(),
  getScopeFromContextMock: vi.fn(),
}));

vi.mock("../../../src/bot/handlers/prompt.js", () => ({
  processUserPrompt: mocked.processUserPromptMock,
}));

vi.mock("../../../src/bot/scope.js", () => ({
  GLOBAL_SCOPE_KEY: "global",
  getScopeFromContext: mocked.getScopeFromContextMock,
}));

function createContext(threadId: number): Context {
  return {
    chat: { id: -100123, type: "supergroup" },
    message: { text: "Test", message_thread_id: threadId },
  } as unknown as Context;
}

const OPTIONS = { windowMs: 1000, minLength: 3500 };
const DEPS = {
  bot: {} as Bot<Context>,
  ensureEventSubscription: vi.fn(),
};

describe("bot/handlers/prompt-coalescer", () => {
  beforeEach(() => {
    __resetPromptCoalescerForTests();
    mocked.processUserPromptMock.mockReset();
    mocked.getScopeFromContextMock.mockReset();
    vi.useRealTimers();
  });

  it("submits short messages immediately without buffering", () => {
    const ctx = createContext(555);
    mocked.getScopeFromContextMock.mockReturnValue({ key: "-100123:555" });

    queueCoalescedPrompt(ctx, "Short prompt", DEPS, OPTIONS);

    expect(mocked.processUserPromptMock).toHaveBeenCalledTimes(1);
    expect(mocked.processUserPromptMock).toHaveBeenCalledWith(ctx, "Short prompt", DEPS);
  });

  it("buffers a long message and flushes it after the coalescing window", () => {
    vi.useFakeTimers();
    const ctx = createContext(555);
    mocked.getScopeFromContextMock.mockReturnValue({ key: "-100123:555" });

    queueCoalescedPrompt(ctx, "x".repeat(4000), DEPS, OPTIONS);

    expect(mocked.processUserPromptMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(mocked.processUserPromptMock).toHaveBeenCalledTimes(1);
    expect(mocked.processUserPromptMock).toHaveBeenCalledWith(ctx, "x".repeat(4000), DEPS);
  });

  it("merges consecutive long messages into one prompt", () => {
    vi.useFakeTimers();
    const ctx = createContext(555);
    mocked.getScopeFromContextMock.mockReturnValue({ key: "-100123:555" });

    queueCoalescedPrompt(ctx, "x".repeat(4000), DEPS, OPTIONS);
    vi.advanceTimersByTime(300);
    queueCoalescedPrompt(ctx, "continuation", DEPS, OPTIONS);

    expect(mocked.processUserPromptMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(mocked.processUserPromptMock).toHaveBeenCalledTimes(1);
    expect(mocked.processUserPromptMock).toHaveBeenCalledWith(
      ctx,
      `${"x".repeat(4000)}\n\ncontinuation`,
      DEPS,
    );
  });

  it("extends the window when a continuation arrives near the deadline", () => {
    vi.useFakeTimers();
    const ctx = createContext(555);
    mocked.getScopeFromContextMock.mockReturnValue({ key: "-100123:555" });

    queueCoalescedPrompt(ctx, "x".repeat(4000), DEPS, OPTIONS);
    vi.advanceTimersByTime(900);
    expect(mocked.processUserPromptMock).not.toHaveBeenCalled();

    queueCoalescedPrompt(ctx, "part-2", DEPS, OPTIONS);
    vi.advanceTimersByTime(900);
    expect(mocked.processUserPromptMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(mocked.processUserPromptMock).toHaveBeenCalledTimes(1);
    expect(mocked.processUserPromptMock).toHaveBeenCalledWith(
      ctx,
      `${"x".repeat(4000)}\n\npart-2`,
      DEPS,
    );
  });

  it("keeps coalescing buffers independent per scope", () => {
    vi.useFakeTimers();
    const ctxA = createContext(555);
    const ctxB = createContext(777);
    mocked.getScopeFromContextMock.mockImplementation(
      (ctx: Context) => ({ key: ctx.message?.message_thread_id === 555 ? "-100123:555" : "-100123:777" }),
    );

    queueCoalescedPrompt(ctxA, "x".repeat(4000), DEPS, OPTIONS);
    queueCoalescedPrompt(ctxB, "y".repeat(4000), DEPS, OPTIONS);

    vi.advanceTimersByTime(1000);

    expect(mocked.processUserPromptMock).toHaveBeenCalledTimes(2);
    expect(mocked.processUserPromptMock).toHaveBeenCalledWith(ctxA, "x".repeat(4000), DEPS);
    expect(mocked.processUserPromptMock).toHaveBeenCalledWith(ctxB, "y".repeat(4000), DEPS);
  });
});