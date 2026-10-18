import { afterEach, describe, expect, it, vi } from "vitest";

const { subscribeMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
}));

vi.mock("../../src/opencode/client.js", () => ({
  v2Client: {
    event: {
      subscribe: subscribeMock,
    },
  },
  rememberPermissionRequest: vi.fn(),
  forgetPermissionRequest: vi.fn(),
  rememberForm: vi.fn(),
  forgetForm: vi.fn(),
}));

import {
  stopEventListening,
  subscribeToEvents,
  translateV2Event,
  unsubscribeFromEvents,
} from "../../src/opencode/events.js";

type V2EventLike = { type: string; data?: unknown };

function controllableStream(
  signal: AbortSignal,
  events: V2EventLike[],
): AsyncGenerator<V2EventLike> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
}

function finiteStream(): AsyncGenerator<V2EventLike> {
  return (async function* () {
    return;
  })();
}

function delayedStream(
  signal: AbortSignal,
  delayMs: number,
  events: V2EventLike[],
): AsyncGenerator<V2EventLike> {
  return (async function* () {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    for (const event of events) {
      yield event;
    }
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe("opencode/events", () => {
  afterEach(async () => {
    stopEventListening();
    await settle();
    subscribeMock.mockReset();
  });

  it("uses one global subscription and forwards translated events", async () => {
    subscribeMock.mockImplementation((options: { signal: AbortSignal }) =>
      controllableStream(options.signal, [{ type: "session.idle", data: { sessionID: "s1" } }]),
    );

    const callback = vi.fn();
    await subscribeToEvents("/repo/a", callback);

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(1);
    });

    expect(callback.mock.calls[0][0]).toEqual({
      type: "session.idle",
      properties: { sessionID: "s1" },
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("delivers each global event exactly once to a shared callback", async () => {
    subscribeMock.mockImplementation((options: { signal: AbortSignal }) =>
      controllableStream(options.signal, [{ type: "session.idle", data: { sessionID: "s1" } }]),
    );

    const callback = vi.fn();
    await subscribeToEvents("/repo/a", callback);
    await subscribeToEvents("/repo/b", callback);

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(1);
    });

    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("fans out to distinct callbacks", async () => {
    subscribeMock.mockImplementation((options: { signal: AbortSignal }) =>
      controllableStream(options.signal, [{ type: "session.idle", data: { sessionID: "s1" } }]),
    );

    const callbackA = vi.fn();
    const callbackB = vi.fn();
    await subscribeToEvents("/repo/a", callbackA);
    await subscribeToEvents("/repo/b", callbackB);

    await vi.waitFor(() => {
      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackB).toHaveBeenCalledTimes(1);
    });

    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("can unsubscribe a callback without stopping others", async () => {
    subscribeMock.mockImplementation((options: { signal: AbortSignal }) =>
      delayedStream(options.signal, 30, [{ type: "session.idle", data: { sessionID: "s1" } }]),
    );

    const callbackA = vi.fn();
    const callbackB = vi.fn();
    await subscribeToEvents("/repo/a", callbackA);
    await subscribeToEvents("/repo/a", callbackB);
    unsubscribeFromEvents("/repo/a", callbackA);

    await vi.waitFor(() => {
      expect(callbackB).toHaveBeenCalledTimes(1);
    });
    expect(callbackA).not.toHaveBeenCalled();
  });

  it("reconnects after the stream ends", async () => {
    subscribeMock
      .mockImplementationOnce(() => finiteStream())
      .mockImplementationOnce((options: { signal: AbortSignal }) =>
        controllableStream(options.signal, []),
      );

    await subscribeToEvents("/repo/a", vi.fn());

    await vi.waitFor(
      () => {
        expect(subscribeMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
  });
});

describe("translateV2Event", () => {
  it("maps execution.succeeded to session.idle", () => {
    const translated = translateV2Event({
      type: "session.execution.succeeded",
      data: { sessionID: "s1" },
    } as never);

    expect(translated).toEqual({ type: "session.idle", properties: { sessionID: "s1" } });
  });

  it("maps text deltas to message.part.delta", () => {
    const translated = translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 0, delta: "hi" },
    } as never);

    expect(translated).toEqual({
      type: "message.part.delta",
      properties: {
        sessionID: "s1",
        messageID: "m1",
        partID: "m1:text:0",
        field: "text",
        delta: "hi",
      },
    });
  });

  it("maps permission.asked to the v1 permission shape", () => {
    const translated = translateV2Event({
      type: "permission.asked",
      data: {
        id: "p1",
        sessionID: "s1",
        action: "bash",
        resources: ["ls"],
        save: ["ls"],
        metadata: { command: "ls" },
      },
    } as never);

    expect(translated).toEqual({
      type: "permission.asked",
      properties: {
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["ls"],
        metadata: { command: "ls" },
        always: ["ls"],
      },
    });
  });

  it("maps form.created to question.asked", () => {
    const translated = translateV2Event({
      type: "form.created",
      data: {
        form: {
          id: "f1",
          sessionID: "s1",
          title: "Pick",
          fields: [
            {
              key: "choice",
              type: "multiselect",
              title: "Choose one",
              description: "Pick an option",
              options: [{ value: "a", label: "A", description: "Option A" }],
            },
          ],
        },
      },
    } as never);

    expect(translated).toEqual({
      type: "question.asked",
      properties: {
        id: "f1",
        sessionID: "s1",
        questions: [
          {
            question: "Pick an option",
            header: "Choose one",
            options: [{ label: "a", description: "Option A" }],
            multiple: true,
            custom: true,
          },
        ],
      },
    });
  });
});
