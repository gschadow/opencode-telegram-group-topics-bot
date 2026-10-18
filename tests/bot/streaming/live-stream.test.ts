import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveStream } from "../../../src/bot/streaming/live-stream.js";

describe("bot/streaming/live-stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps assistant and service updates in one stream lane", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(101);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "Assistant start");
    stream.pushServiceUpdate("s1", "⏳ bash npm test");
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenCalledWith(
      "s1",
      "Assistant start\n\n⏳ bash npm test",
      "markdown_v2",
      false,
    );
    expect(editText).not.toHaveBeenCalled();
  });

  it("seals thinking into its own message and starts assistant text fresh", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(102).mockResolvedValueOnce(103);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.showThinking("s1", "Thinking");
    await vi.advanceTimersByTimeAsync(50);
    await stream.updateAssistant("s1", "m1", "Assistant start");
    await vi.advanceTimersByTimeAsync(50);

    // The thinking block must be sealed into its own message and the final
    // response must start a fresh, separate message (never appended onto the
    // thinking message).
    expect(sendText).toHaveBeenNthCalledWith(1, "s1", "💭 Thinking", "markdown_v2", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "s1", "Assistant start", "markdown_v2", false);
    expect(editText).not.toHaveBeenCalled();
  });

  it("starts a new streamed message after a file boundary seal", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.completeAssistant("s1", "m1", "Before file");
    await stream.sealCurrentMessage("s1");
    await stream.updateAssistant("s1", "m1", "Before file\n\nAfter file");
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenNthCalledWith(1, "s1", "Before file", "markdown_v2", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "s1", "After file", "markdown_v2", false);
  });

  it("does not replay the just-sealed assistant prefix after a file boundary", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(12).mockResolvedValueOnce(13);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "Cycle 1: first update to the file.");
    await vi.advanceTimersByTimeAsync(50);

    await stream.sealCurrentMessage("s1", false, true);
    await stream.updateAssistant(
      "s1",
      "m2",
      "Cycle 1: first update to the file.\n\nCycle 2: second update to the file.",
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenNthCalledWith(
      1,
      "s1",
      "Cycle 1: first update to the file\\.",
      "markdown_v2",
      false,
    );
    expect(sendText).toHaveBeenNthCalledWith(
      2,
      "s1",
      "Cycle 2: second update to the file\\.",
      "markdown_v2",
      false,
    );
  });

  it("starts a fresh streamed message after a hard seal", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(14).mockResolvedValueOnce(15);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "Before question");
    await vi.advanceTimersByTimeAsync(50);

    await stream.sealCurrentMessage("s1", true);
    await stream.updateAssistant("s1", "m1", "After question");
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenNthCalledWith(1, "s1", "Before question", "markdown_v2", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "s1", "After question", "markdown_v2", false);
  });

  it("starts a new service stream after an assistant-only boundary break", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(16).mockResolvedValueOnce(17);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "Interim answer");
    await vi.advanceTimersByTimeAsync(50);

    await stream.breakServiceBoundary("s1");
    stream.replaceServiceByPrefix("s1", "__tool__:call-1", "⏳ bash npm test");
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenNthCalledWith(1, "s1", "Interim answer", "markdown_v2", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "s1", "⏳ bash npm test", "markdown_v2", false);
    expect(editText).not.toHaveBeenCalled();
  });

  it("starts a new assistant stream after a service-only boundary break", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(21).mockResolvedValueOnce(22);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    stream.replaceServiceByPrefix("s1", "__tool__:call-1", "⏳ bash npm test");
    await vi.advanceTimersByTimeAsync(50);

    await stream.updateAssistant("s1", "m2", "Small reply");
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenNthCalledWith(1, "s1", "⏳ bash npm test", "markdown_v2", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "s1", "Small reply", "markdown_v2", false);
    expect(editText).not.toHaveBeenCalled();
  });

  it("updates the current assistant entry in place while keeping service order", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(20);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "First message");
    await vi.advanceTimersByTimeAsync(50);
    stream.pushServiceUpdate("s1", "✅ tool finished");
    await stream.updateAssistant("s1", "m1", "First message extended");
    await vi.advanceTimersByTimeAsync(50);

    expect(editText).toHaveBeenCalledWith(
      "s1",
      20,
      "First message extended\n\n✅ tool finished",
      "markdown_v2",
      false,
    );
  });

  it("rolls over into a new message when the stream exceeds Telegram length", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(31).mockResolvedValueOnce(32);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    const longText = `${"A".repeat(3000)}\n\n${"B".repeat(1800)}`;
    await stream.updateAssistant("s1", "m1", longText);
    await vi.advanceTimersByTimeAsync(50);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[0][1].length).toBeLessThanOrEqual(4096);
    expect(sendText.mock.calls[1][1].length).toBeLessThanOrEqual(4096);
    expect(editText).not.toHaveBeenCalled();
  });

  it("does not re-send archived thinking prefix when thinking grows past the Telegram limit", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(200);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    // One giant thinking line that already exceeds one Telegram message.
    const bigThinking = "x".repeat(4200);
    await stream.showThinking("s1", bigThinking);
    await vi.advanceTimersByTimeAsync(50);

    // Extend the thinking further. The extension must only carry the delta —
    // it must be applied via edit on the growing message, never re-sent as a
    // fresh message that re-includes the already-archived prefix.
    await stream.showThinking("s1", `${bigThinking} yyy`);
    await vi.advanceTimersByTimeAsync(50);

    const sentTexts = sendText.mock.calls.map((call) => call[1]);
    // First send: the 4096-char prefix. Second send: the 107-char tail that
    // could not fit. The " yyy" extension must NOT produce a third send.
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sentTexts[0].length).toBe(4096);
    // The extension lands as an edit appending the delta to the tail message.
    expect(editText).toHaveBeenCalled();
    const lastEditText = editText.mock.calls.at(-1)![2] as string;
    expect(lastEditText).toContain(" yyy");
    expect(lastEditText.length).toBeLessThanOrEqual(4096);
  });

  it("splits oversized replaceable service updates at the Telegram limit without truncating content", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(51);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    const payload = `🧩 ${"x".repeat(5000)}`;
    stream.replaceServiceByPrefix("s1", "🧩", payload);
    await vi.advanceTimersByTimeAsync(50);

    const sentTexts = sendText.mock.calls.map((call) => call[1]);
    expect(sentTexts.length).toBeGreaterThan(1);
    expect(sentTexts.every((text) => text.length <= 4096)).toBe(true);
    expect(sentTexts.join("")).toBe(payload);
    expect(sentTexts.join("")).not.toContain("...");
  });

  it("splits oversized streams at the converted MarkdownV2 length, not the raw length", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(71);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    // Raw text is ~2900 chars (under the 4096 raw limit) but MarkdownV2
    // escaping inflates it to ~5300 converted chars, which Telegram rejects.
    const longText = `${"|".repeat(2400)}\n\n${"B".repeat(500)}`;
    await stream.updateAssistant("s1", "m1", longText);
    await vi.advanceTimersByTimeAsync(50);

    const sentTexts = sendText.mock.calls.map((call) => call[1]);
    expect(sentTexts.length).toBeGreaterThan(1);
    expect(sentTexts.every((text) => text.length <= 4096)).toBe(true);

    const restored = sentTexts.join("").replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
    expect(restored.replace(/\s/g, "")).toBe(longText.replace(/\s/g, ""));
  });

  it("replaces prior replace-keyed service updates instead of accumulating them", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(52);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    stream.replaceServiceByPrefix("s1", "__todo__", "⏳ todo step 1");
    await vi.advanceTimersByTimeAsync(50);
    stream.replaceServiceByPrefix("s1", "__todo__", "✅ todo step 2");
    await vi.advanceTimersByTimeAsync(50);

    const internalState = (
      stream as unknown as {
        states: Map<
          string,
          {
            service: { updates: string[] };
          }
        >;
      }
    ).states.get("s1");

    expect(editText).toHaveBeenLastCalledWith("s1", 52, "✅ todo step 2", "markdown_v2", false);
    expect(internalState?.service.updates).toEqual(["✅ todo step 2"]);
  });

  it("replaces a tool status update in place when the same call progresses", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(53);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    stream.replaceServiceByPrefix("s1", "__tool__:call-1", "⏳ bash npm test");
    await vi.advanceTimersByTimeAsync(50);
    stream.replaceServiceByPrefix("s1", "__tool__:call-1", "✅ bash npm test");
    await vi.advanceTimersByTimeAsync(50);

    const internalState = (
      stream as unknown as {
        states: Map<
          string,
          {
            service: { updates: string[] };
          }
        >;
      }
    ).states.get("s1");

    expect(sendText).toHaveBeenCalledWith("s1", "⏳ bash npm test", "markdown_v2", false);
    expect(editText).toHaveBeenLastCalledWith("s1", 53, "✅ bash npm test", "markdown_v2", false);
    expect(internalState?.service.updates).toEqual(["✅ bash npm test"]);
  });

  it("keeps assistant rollover progress correct across trimmed boundaries", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(61).mockResolvedValueOnce(62);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    const firstPass = `${"A".repeat(4094)}\n\nB`;
    await stream.updateAssistant("s1", "m1", firstPass);
    await vi.advanceTimersByTimeAsync(50);

    await stream.updateAssistant("s1", "m1", `${firstPass}CCCC`);
    await vi.advanceTimersByTimeAsync(50);

    const renderedParts = sendText.mock.calls.map((call) => call[1]);
    expect(renderedParts[0]).toBe("A".repeat(4094));
    expect(renderedParts[1]).toBe("B");
    expect(editText).toHaveBeenLastCalledWith("s1", 62, "BCCCC", "markdown_v2", false);
  });

  it("seals thinking into its own message and deletes the transient assistant message during final cleanup", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(71).mockResolvedValueOnce(72);
    const editText = vi.fn().mockResolvedValue(undefined);
    const deleteText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, deleteText, throttleMs: 50 });

    await stream.showThinking("s1", "Thinking");
    await stream.updateAssistant("s1", "m1", "Final answer");
    await vi.advanceTimersByTimeAsync(50);

    await stream.cleanupAfterFinalDelivery("s1");

    expect(sendText).toHaveBeenNthCalledWith(1, "s1", "💭 Thinking", "markdown_v2", false);
    expect(sendText).toHaveBeenNthCalledWith(2, "s1", "Final answer", "markdown_v2", false);
    // The transient assistant-only message is deleted; the thinking message stays.
    expect(deleteText).toHaveBeenCalledWith("s1", 72);
    expect(editText).not.toHaveBeenCalled();
  });

  it("deletes the transient stream message when it only contained assistant text", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(81);
    const editText = vi.fn().mockResolvedValue(undefined);
    const deleteText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, deleteText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "Final answer");
    await vi.advanceTimersByTimeAsync(50);

    await stream.cleanupAfterFinalDelivery("s1");

    expect(deleteText).toHaveBeenCalledWith("s1", 81);
    expect(editText).not.toHaveBeenCalled();
  });

  it("deletes rolled assistant-only stream messages during final cleanup", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(91).mockResolvedValueOnce(92);
    const editText = vi.fn().mockResolvedValue(undefined);
    const deleteText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, deleteText, throttleMs: 50 });

    const longText = `${"A".repeat(3000)}\n\n${"B".repeat(1800)}`;
    await stream.updateAssistant("s1", "m1", longText);
    await vi.advanceTimersByTimeAsync(50);

    await stream.cleanupAfterFinalDelivery("s1");

    expect(deleteText).toHaveBeenNthCalledWith(1, "s1", 91);
    expect(deleteText).toHaveBeenNthCalledWith(2, "s1", 92);
  });

  it("finalizes a single assistant-only stream message in place", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(101);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    await stream.updateAssistant("s1", "m1", "Final answer");
    await vi.advanceTimersByTimeAsync(50);

    await expect(
      stream.finalizeCurrentMessage("s1", {
        format: "markdown_v2",
        includeKeyboard: true,
        rawFallbackText: "Final answer",
      }),
    ).resolves.toBe(true);

    expect(editText).toHaveBeenLastCalledWith(
      "s1",
      101,
      "Final answer",
      "markdown_v2",
      true,
      "Final answer",
    );
    const internalState = (
      stream as unknown as {
        states: Map<
          string,
          {
            messageId: number | null;
            entries: unknown[];
          }
        >;
      }
    ).states.get("s1");
    expect(internalState?.messageId).toBeNull();
    expect(internalState?.entries).toEqual([]);
  });

  it("does not finalize in place after stream rollover", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValueOnce(111).mockResolvedValueOnce(112);
    const editText = vi.fn().mockResolvedValue(undefined);
    const stream = new LiveStream({ sendText, editText, throttleMs: 50 });

    const longText = `${"A".repeat(3000)}\n\n${"B".repeat(1800)}`;
    await stream.updateAssistant("s1", "m1", longText);
    await vi.advanceTimersByTimeAsync(50);

    await expect(
      stream.finalizeCurrentMessage("s1", {
        format: "markdown_v2",
        includeKeyboard: true,
        rawFallbackText: longText,
      }),
    ).resolves.toBe(false);

    expect(editText).not.toHaveBeenCalledWith(
      "s1",
      112,
      expect.any(String),
      "markdown_v2",
      true,
      longText,
    );
  });

  it("does not leak an unhandled rejection when a queued task fails", async () => {
    vi.useFakeTimers();

    const sendText = vi.fn().mockResolvedValue(101);
    const editText = vi.fn().mockResolvedValue(undefined);
    const editRenderedPart = vi.fn().mockRejectedValue(new Error("boom"));
    const stream = new LiveStream({ sendText, editText, editRenderedPart, throttleMs: 50 });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await stream.updateAssistant("s1", "m1", "Final answer");
      await vi.advanceTimersByTimeAsync(50);

      await expect(
        stream.finalizeCurrentMessage("s1", {
          format: "markdown_v2",
          includeKeyboard: false,
          renderedPart: { text: "Final answer", fallbackText: "Final answer", source: "plain" },
        }),
      ).rejects.toThrow("boom");

      // Let any derived microtask rejections surface.
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
