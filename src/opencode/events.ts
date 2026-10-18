import type { OpenCodeEvent } from "@opencode/client/promise";
import {
  v2Client,
  rememberPermissionRequest,
  forgetPermissionRequest,
  rememberForm,
  forgetForm,
} from "./client.js";
import type { Event, Part, QuestionInfo, Session, ToolState } from "./v1-types.js";
import { logger } from "../utils/logger.js";

type EventCallback = (event: Event) => void | Promise<void>;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

const callbacksByDirectory = new Map<string, Set<EventCallback>>();
let loopPromise: Promise<void> | null = null;
let abortController: AbortController | null = null;

interface ToolTrack {
  tool: string;
  input: Record<string, unknown>;
  start: number;
}

const toolTracks = new Map<string, ToolTrack>();
const reasoningTextByPart = new Map<string, string>();

function toolKey(sessionID: string, toolID: string): string {
  return `${sessionID}:${toolID}`;
}

function getReconnectDelayMs(attempt: number): number {
  const exponentialDelay = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function activeCallbacks(): EventCallback[] {
  const unique = new Set<EventCallback>();
  for (const set of callbacksByDirectory.values()) {
    for (const callback of set) {
      unique.add(callback);
    }
  }
  return Array.from(unique);
}

async function dispatchEvent(event: Event): Promise<void> {
  const callbacks = activeCallbacks();
  for (const callback of callbacks) {
    try {
      await callback(event);
    } catch (error) {
      logger.error("[Events] Event callback failed", { eventType: event.type }, error);
    }
  }
}

// ---------------------------------------------------------------------------
// v2 -> v1 translation
// ---------------------------------------------------------------------------

function textPartID(messageID: string, ordinal: number): string {
  return `${messageID}:text:${ordinal}`;
}

function reasoningPartID(messageID: string, ordinal: number): string {
  return `${messageID}:reasoning:${ordinal}`;
}

function adaptStructuredError(error?: { type?: string; message?: string }): {
  name?: string;
  message?: string;
  data?: { message?: string };
} {
  const message = error?.message;
  return {
    name: error?.type,
    message,
    data: message ? { message } : undefined,
  };
}

function fieldOptions(field: unknown): Array<{ label: string; description: string }> {
  const options = (field as { options?: unknown }).options;
  if (!Array.isArray(options)) {
    return [];
  }

  return options.map((option) => {
    const value = (option as { value?: unknown }).value;
    const label = (option as { label?: unknown }).label;
    const description = (option as { description?: unknown }).description;
    return {
      label: String(value ?? label ?? ""),
      description: String(description ?? label ?? ""),
    };
  });
}

function fieldToQuestion(field: unknown): QuestionInfo {
  const typed = field as { key?: string; title?: string; description?: string; type?: string };
  return {
    question: String(typed.description ?? typed.title ?? typed.key ?? ""),
    header: String(typed.title ?? typed.key ?? ""),
    options: fieldOptions(field),
    multiple: typed.type === "multiselect",
    custom: true,
  };
}

function sessionInfoFromCreated(data: {
  sessionID: string;
  parentID?: string;
  title?: string;
  location?: { directory?: string };
}): Session {
  return {
    id: data.sessionID,
    directory: data.location?.directory ?? "",
    title: data.title ?? "",
    parentID: data.parentID,
    time: { created: Date.now(), updated: Date.now() },
  };
}

/**
 * Translate a v2 event into the v1-shaped events the aggregator consumes.
 * Returns null for events that have no v1 equivalent the bot cares about.
 * Some v2 events expand into more than one v1 event.
 */
export function translateV2Event(event: OpenCodeEvent): Event | Event[] | null {
  switch (event.type) {
    case "session.created": {
      const info = sessionInfoFromCreated(event.data);
      return { type: "session.created", properties: { info } };
    }

    case "session.renamed": {
      const info: Session = {
        id: event.data.sessionID,
        directory: "",
        title: event.data.title,
        time: { created: Date.now(), updated: Date.now() },
      };
      return { type: "session.updated", properties: { info } };
    }

    case "session.status": {
      const status = event.data.status as { type: string; [key: string]: unknown };
      return {
        type: "session.status",
        properties: {
          sessionID: event.data.sessionID,
          status: status as never,
        },
      };
    }

    case "session.idle": {
      return { type: "session.idle", properties: { sessionID: event.data.sessionID } };
    }

    case "session.execution.succeeded": {
      // v2 marks the end of a busy period with execution.succeeded; the
      // `session.idle` event is deprecated and not published by this server.
      return { type: "session.idle", properties: { sessionID: event.data.sessionID } };
    }

    case "session.execution.interrupted": {
      return { type: "session.idle", properties: { sessionID: event.data.sessionID } };
    }

    case "session.retry.scheduled": {
      const { sessionID, attempt, at, error } = event.data;
      return {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt,
            message: error?.message ?? "Retry scheduled",
            next: at,
          } as never,
        },
      };
    }

    case "session.compaction.ended": {
      return { type: "session.compacted", properties: { sessionID: event.data.sessionID } };
    }

    case "session.step.started": {
      const { sessionID, assistantMessageID, agent, model, started, snapshot } = event.data;
      return [
        {
          type: "message.updated",
          properties: {
            info: {
              id: assistantMessageID,
              sessionID,
              role: "assistant",
              time: { created: started },
              agent,
              modelID: model?.id,
              providerID: model?.providerID,
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: `${assistantMessageID}:step-start`,
              sessionID,
              messageID: assistantMessageID,
              type: "step-start",
              snapshot,
            },
          },
        },
      ];
    }

    case "session.step.ended": {
      const { sessionID, assistantMessageID, finish, cost, tokens, snapshot } = event.data;
      return [
        {
          type: "message.updated",
          properties: {
            info: {
              id: assistantMessageID,
              sessionID,
              role: "assistant",
              time: { created: Date.now(), completed: Date.now() },
              cost,
              tokens,
              finish,
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: `${assistantMessageID}:step-finish`,
              sessionID,
              messageID: assistantMessageID,
              type: "step-finish",
              reason: finish,
              snapshot,
              cost,
              tokens,
            },
          },
        },
      ];
    }

    case "session.step.failed": {
      const { sessionID, assistantMessageID, error, cost, tokens } = event.data;
      // Finalize the assistant message with the error; the terminal user-facing
      // error is emitted from session.execution.failed to avoid duplicates.
      return {
        type: "message.updated",
        properties: {
          info: {
            id: assistantMessageID,
            sessionID,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
            cost,
            tokens,
            error: adaptStructuredError(error),
          },
        },
      };
    }

    case "session.execution.failed": {
      const { sessionID, error } = event.data;
      return {
        type: "session.error",
        properties: { sessionID, error: adaptStructuredError(error) },
      };
    }

    case "session.text.started": {
      const { sessionID, assistantMessageID, ordinal } = event.data;
      return {
        type: "message.part.updated",
        properties: {
          part: {
            id: textPartID(assistantMessageID, ordinal),
            sessionID,
            messageID: assistantMessageID,
            type: "text",
            text: "",
            time: { start: Date.now() },
          },
        },
      };
    }

    case "session.text.delta": {
      const { sessionID, assistantMessageID, ordinal, delta } = event.data;
      return {
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID: assistantMessageID,
          partID: textPartID(assistantMessageID, ordinal),
          field: "text",
          delta,
        },
      };
    }

    case "session.text.ended": {
      const { sessionID, assistantMessageID, ordinal, text } = event.data;
      return {
        type: "message.part.updated",
        properties: {
          part: {
            id: textPartID(assistantMessageID, ordinal),
            sessionID,
            messageID: assistantMessageID,
            type: "text",
            text,
            time: { start: Date.now(), end: Date.now() },
          },
        },
      };
    }

    case "session.reasoning.started": {
      // The aggregator streams reasoning from cumulative part updates, not from
      // `message.part.delta` (it only accepts text deltas). Nothing to emit yet.
      return null;
    }

    case "session.reasoning.delta": {
      const { sessionID, assistantMessageID, ordinal, delta } = event.data;
      const partID = reasoningPartID(assistantMessageID, ordinal);
      const text = `${reasoningTextByPart.get(partID) ?? ""}${delta}`;
      reasoningTextByPart.set(partID, text);
      return {
        type: "message.part.updated",
        properties: {
          part: {
            id: partID,
            sessionID,
            messageID: assistantMessageID,
            type: "reasoning",
            text,
            time: { start: Date.now() },
          },
        },
      };
    }

    case "session.reasoning.ended": {
      const { sessionID, assistantMessageID, ordinal, text } = event.data;
      const partID = reasoningPartID(assistantMessageID, ordinal);
      const finalText = text || reasoningTextByPart.get(partID) || "";
      reasoningTextByPart.delete(partID);
      return {
        type: "message.part.updated",
        properties: {
          part: {
            id: partID,
            sessionID,
            messageID: assistantMessageID,
            type: "reasoning",
            text: finalText,
            time: { start: Date.now(), end: Date.now() },
          },
        },
      };
    }

    case "session.tool.input.started": {
      const { sessionID, assistantMessageID, id, name } = event.data;
      toolTracks.set(toolKey(sessionID, id), { tool: name, input: {}, start: Date.now() });
      return toolPartEvent(sessionID, assistantMessageID, id, name, {
        status: "pending",
        input: {},
        raw: "",
      });
    }

    case "session.tool.called": {
      const { sessionID, assistantMessageID, id, input } = event.data;
      const track = toolTracks.get(toolKey(sessionID, id));
      const tool = track?.tool ?? "tool";
      const start = track?.start ?? Date.now();
      if (track) {
        track.input = input;
      } else {
        toolTracks.set(toolKey(sessionID, id), { tool, input, start });
      }
      return toolPartEvent(sessionID, assistantMessageID, id, tool, {
        status: "running",
        input,
        time: { start },
      });
    }

    case "session.tool.progress": {
      const { sessionID, assistantMessageID, id, metadata } = event.data;
      const track = toolTracks.get(toolKey(sessionID, id)) ?? {
        tool: "tool",
        input: {},
        start: Date.now(),
      };
      return toolPartEvent(sessionID, assistantMessageID, id, track.tool, {
        status: "running",
        input: track.input,
        metadata,
        time: { start: track.start },
      });
    }

    case "session.tool.success": {
      const { sessionID, assistantMessageID, id, content, metadata } = event.data;
      const track = toolTracks.get(toolKey(sessionID, id)) ?? {
        tool: "tool",
        input: {},
        start: Date.now(),
      };
      toolTracks.delete(toolKey(sessionID, id));
      const output = Array.isArray(content)
        ? content
            .filter((item) => item.type === "text")
            .map((item) => (item as { text?: string }).text ?? "")
            .join("")
        : "";
      return toolPartEvent(sessionID, assistantMessageID, id, track.tool, {
        status: "completed",
        input: track.input,
        output,
        title: "",
        metadata: metadata ?? {},
        time: { start: track.start, end: Date.now() },
      });
    }

    case "session.tool.failed": {
      const { sessionID, assistantMessageID, id, error, metadata } = event.data;
      const track = toolTracks.get(toolKey(sessionID, id)) ?? {
        tool: "tool",
        input: {},
        start: Date.now(),
      };
      toolTracks.delete(toolKey(sessionID, id));
      return toolPartEvent(sessionID, assistantMessageID, id, track.tool, {
        status: "error",
        input: track.input,
        error: error.message,
        metadata,
        time: { start: track.start, end: Date.now() },
      });
    }

    case "permission.asked": {
      const { id, sessionID, action, resources, save, metadata } = event.data;
      rememberPermissionRequest(id, sessionID);
      return {
        type: "permission.asked",
        properties: {
          id,
          sessionID,
          permission: action,
          patterns: resources ?? [],
          metadata: metadata ?? {},
          always: save ?? [],
        },
      };
    }

    case "permission.replied": {
      const { sessionID, requestID, reply } = event.data;
      forgetPermissionRequest(requestID);
      return {
        type: "permission.replied",
        properties: { sessionID, requestID, reply },
      };
    }

    case "form.created": {
      const form = event.data.form;
      const fields = Array.isArray(form.fields) ? form.fields : [];
      rememberForm(
        form.id,
        form.sessionID,
        fields.map((field) => String((field as { key?: unknown }).key ?? "")),
      );
      return {
        type: "question.asked",
        properties: {
          id: form.id,
          sessionID: form.sessionID,
          questions: fields.map(fieldToQuestion),
        },
      };
    }

    case "form.replied": {
      const { id, sessionID } = event.data;
      forgetForm(id);
      return {
        type: "question.replied",
        properties: { sessionID, requestID: id, answers: [] },
      };
    }

    case "form.cancelled": {
      const { id, sessionID } = event.data;
      forgetForm(id);
      return {
        type: "question.rejected",
        properties: { sessionID, requestID: id },
      };
    }

    default:
      return null;
  }
}

function toolPartEvent(
  sessionID: string,
  messageID: string,
  toolID: string,
  tool: string,
  state: ToolState,
): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: toolID,
        sessionID,
        messageID,
        type: "tool",
        callID: toolID,
        tool,
        state,
        metadata: (state as { metadata?: Record<string, unknown> }).metadata,
      } satisfies Part,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream loop
// ---------------------------------------------------------------------------

async function runWorkerLoop(): Promise<void> {
  let reconnectAttempt = 0;

  while (abortController && !abortController.signal.aborted) {
    if (activeCallbacks().length === 0) {
      break;
    }

    try {
      const stream = v2Client.event.subscribe({ signal: abortController.signal });
      reconnectAttempt = 0;

      for await (const event of stream) {
        if (!abortController || abortController.signal.aborted || activeCallbacks().length === 0) {
          break;
        }

        try {
          const translated = translateV2Event(event);
          const events = translated
            ? Array.isArray(translated)
              ? translated
              : [translated]
            : [];
          for (const v1Event of events) {
            await dispatchEvent(v1Event);
          }
        } catch (error) {
          logger.error("[Events] Failed to translate v2 event", { type: event.type }, error);
        }
      }

      if (!abortController || abortController.signal.aborted || activeCallbacks().length === 0) {
        break;
      }

      reconnectAttempt++;
      const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
      logger.warn("[Events] v2 stream ended, reconnecting", { reconnectAttempt, reconnectDelay });
      if (!(await waitWithAbort(reconnectDelay, abortController.signal))) {
        break;
      }
    } catch (error) {
      if (!abortController || abortController.signal.aborted || activeCallbacks().length === 0) {
        break;
      }

      reconnectAttempt++;
      const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
      logger.error("[Events] v2 stream failed, reconnecting", { reconnectAttempt, reconnectDelay }, error);
      if (!(await waitWithAbort(reconnectDelay, abortController.signal))) {
        break;
      }
    }
  }
}

function ensureWorkerStarted(): void {
  if (loopPromise) {
    return;
  }

  abortController = new AbortController();
  loopPromise = runWorkerLoop()
    .catch((error) => {
      logger.error("[Events] Worker loop failed unexpectedly", error);
    })
    .finally(() => {
      loopPromise = null;
      abortController = null;
    });
}

export async function subscribeToEvents(directory: string, callback: EventCallback): Promise<void> {
  let set = callbacksByDirectory.get(directory);
  if (!set) {
    set = new Set<EventCallback>();
    callbacksByDirectory.set(directory, set);
  }
  set.add(callback);
  ensureWorkerStarted();
}

export function unsubscribeFromEvents(directory: string, callback: EventCallback): void {
  const set = callbacksByDirectory.get(directory);
  if (!set) {
    return;
  }

  set.delete(callback);
  if (set.size === 0) {
    callbacksByDirectory.delete(directory);
  }
}

export function stopEventListening(directory?: string): void {
  if (directory) {
    callbacksByDirectory.delete(directory);
    logger.info("[Events] Stopped event listener", { directory });
    return;
  }

  callbacksByDirectory.clear();
  abortController?.abort();
  logger.info("[Events] Stopped all event listeners");
}
