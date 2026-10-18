import os from "node:os";
import path from "node:path";
import { OpenCode } from "@opencode/client/promise";
import type {
  AgentInfo as V2AgentInfo,
  FileDiffInfo,
  McpListOutput,
  ModelInfo as V2ModelInfo,
  ProviderInfo as V2ProviderInfo,
  SessionInfo as V2SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
} from "@opencode/client/promise";
import { config } from "../config.js";
import type {
  Agent,
  Command,
  FileDiff,
  Message,
  Model,
  Part,
  PermissionReply,
  Provider,
  ProviderList,
  Project,
  Session,
  TextPartInput,
  FilePartInput,
  ToolState,
} from "./v1-types.js";

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

/**
 * The raw v2 client. Its methods return data directly (not `{data, error}`)
 * and speak the `/api/*` surface served by the v2 server.
 */
export const v2Client = OpenCode.make({
  baseUrl: config.opencode.apiUrl,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
});

/**
 * Result envelope mirroring the old v1 SDK's `{ data, error }` shape so the
 * existing call sites keep working unchanged. Exactly one of `data`/`error`
 * is populated; both keys always exist so destructuring type-checks.
 */
export type V1Result<T> = { data: T; error: undefined } | { data: undefined; error: unknown };

async function wrap<T>(fn: () => Promise<T>): Promise<V1Result<T>> {
  try {
    return { data: await fn(), error: undefined };
  } catch (error) {
    return { data: undefined, error };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Request registry
//
// v2 `permission.reply` and `session.form.reply` require the owning sessionID,
// but the bot's call sites only pass the request id (plus a directory). We
// remember the mapping when the corresponding events are translated so replies
// can be routed back without changing those call sites.
// ---------------------------------------------------------------------------

const permissionSessionById = new Map<string, string>();
const formSessionById = new Map<string, string>();
const formFieldKeysById = new Map<string, string[]>();

export function rememberPermissionRequest(requestID: string, sessionID: string): void {
  permissionSessionById.set(requestID, sessionID);
}

export function forgetPermissionRequest(requestID: string): void {
  permissionSessionById.delete(requestID);
}

export function rememberForm(formID: string, sessionID: string, fieldKeys: string[]): void {
  formSessionById.set(formID, sessionID);
  formFieldKeysById.set(formID, fieldKeys);
}

export function forgetForm(formID: string): void {
  formSessionById.delete(formID);
  formFieldKeysById.delete(formID);
}

// ---------------------------------------------------------------------------
// v2 -> v1 adapters
// ---------------------------------------------------------------------------

function extractToolText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("");
}

function adaptToolState(
  toolName: string,
  state: SessionMessageAssistantToolState,
  time: { created: number; ran?: number; completed?: number },
): ToolState {
  const start = time.ran ?? time.created;
  switch (state.status) {
    case "streaming":
      return { status: "pending", input: {}, raw: state.input };
    case "running":
      return {
        status: "running",
        input: state.input,
        metadata: state.metadata,
        time: { start },
      };
    case "completed":
      return {
        status: "completed",
        input: state.input,
        output: extractToolText(state.content),
        title: toolName,
        metadata: state.metadata ?? {},
        time: { start, end: time.completed ?? start },
      };
    case "error":
      return {
        status: "error",
        input: state.input,
        error: state.error.message,
        metadata: state.metadata,
        time: { start, end: time.completed ?? start },
      };
    default:
      return { status: "pending", input: {}, raw: "" };
  }
}

type SessionMessageAssistantTool = Extract<
  SessionMessageAssistant["content"][number],
  { type: "tool" }
>;
type SessionMessageAssistantToolState = SessionMessageAssistantTool["state"];

function adaptAssistantParts(
  message: SessionMessageAssistant,
  sessionID: string,
): Part[] {
  const parts: Part[] = [];

  message.content.forEach((content, index) => {
    if (content.type === "text") {
      parts.push({
        id: `${message.id}:text:${index}`,
        sessionID,
        messageID: message.id,
        type: "text",
        text: content.text,
      });
    } else if (content.type === "reasoning") {
      parts.push({
        id: `${message.id}:reasoning:${index}`,
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: content.text,
        time: { start: message.time.created, end: message.time.completed },
      });
    } else if (content.type === "tool") {
      parts.push({
        id: content.id,
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: content.id,
        tool: content.name,
        state: adaptToolState(content.name, content.state, content.time),
        metadata: (content.state as { metadata?: Record<string, unknown> }).metadata,
      });
    }
  });

  return parts;
}

function adaptMessage(
  message: SessionMessageInfo,
  sessionID: string,
): { info: Message; parts: Part[] } | null {
  if (message.type === "user") {
    return {
      info: {
        id: message.id,
        sessionID,
        role: "user",
        time: { created: message.time.created },
      },
      parts: [
        {
          id: `${message.id}:text:0`,
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.text,
        },
      ],
    };
  }

  if (message.type === "assistant") {
    return {
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        time: { created: message.time.created, completed: message.time.completed },
        cost: message.cost,
        tokens: message.tokens,
        finish: message.finish,
        error: message.error
          ? { name: message.error.type, message: message.error.message, data: { message: message.error.message } }
          : undefined,
        agent: message.agent,
        modelID: message.model.id,
        providerID: message.model.providerID,
      },
      parts: adaptAssistantParts(message, sessionID),
    };
  }

  if (message.type === "compaction" && message.status === "completed") {
    return {
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        summary: true,
        time: { created: message.time.created, completed: message.time.created },
        cost: message.cost,
        tokens: message.tokens,
      },
      parts: [
        {
          id: `${message.id}:text:0`,
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.summary,
        },
      ],
    };
  }

  if (message.type === "idle" && message.error) {
    return {
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        time: { created: message.time.created, completed: message.time.created },
        error: {
          name: message.error.type,
          message: message.error.message,
          data: { message: message.error.message },
        },
      },
      parts: [],
    };
  }

  return null;
}

function adaptSession(info: V2SessionInfo): Session {
  return {
    ...info,
    id: info.id,
    directory: info.location?.directory ?? "",
    title: info.title ?? "",
    parentID: info.parentID,
    time: {
      created: info.time.created,
      updated: info.time.updated,
      idle: info.time.idle,
      archived: info.time.archived,
    },
    metadata: info.metadata,
    cost: info.cost,
    tokens: info.tokens,
  };
}

function adaptProject(project: {
  id: string;
  canonical: string;
  name?: string;
  time: { created: number; updated: number; active: number; archived?: number };
}): Project {
  return {
    id: project.id,
    worktree: project.canonical,
    name: project.name,
    time: { created: project.time.created, updated: project.time.updated },
  };
}

function adaptModel(model: V2ModelInfo): Model {
  const input = new Set(model.capabilities.input);
  const output = new Set(model.capabilities.output);
  const variants: Record<string, { disabled?: boolean }> = {};
  for (const variant of model.variants) {
    variants[variant.id] = { disabled: false };
  }

  return {
    id: model.modelID,
    providerID: model.providerID,
    name: model.name,
    capabilities: {
      temperature: model.capabilities.temperature ?? false,
      reasoning: false,
      attachment:
        input.has("image") || input.has("pdf") || input.has("audio") || input.has("video"),
      toolcall: model.capabilities.tools,
      interleaved: false,
      input: {
        text: input.has("text"),
        audio: input.has("audio"),
        image: input.has("image"),
        video: input.has("video"),
        pdf: input.has("pdf"),
      },
      output: {
        text: output.has("text"),
        audio: output.has("audio"),
        image: output.has("image"),
        video: output.has("video"),
        pdf: output.has("pdf"),
      },
    },
    variants: Object.keys(variants).length > 0 ? variants : undefined,
    limit: { context: model.limit.context, output: model.limit.output },
  };
}

function adaptAgent(agent: V2AgentInfo): Agent {
  return {
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
  };
}

function parseModelString(
  value: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!value) {
    return undefined;
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return undefined;
  }
  return {
    providerID: value.slice(0, slashIndex),
    modelID: value.slice(slashIndex + 1),
  };
}

function permissionRulesToV2(  rules: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> | undefined,
): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> | undefined {
  if (!rules) {
    return undefined;
  }
  return rules.map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }));
}

// ---------------------------------------------------------------------------
// Input types (v1-shaped, as used by the bot)
// ---------------------------------------------------------------------------

export type PromptRequest = {
  sessionID: string;
  directory?: string;
  parts?: Array<TextPartInput | FilePartInput | { type: string; [key: string]: unknown }>;
  model?: { providerID: string; modelID: string; options?: unknown };
  agent?: string;
  variant?: string;
  system?: string;
  messageID?: string;
};

export type SessionCreateInput = {
  directory?: string;
  title?: string;
  parentID?: string;
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
};

export type SessionListInput = {
  limit?: number;
  order?: "asc" | "desc";
  directory?: string;
  roots?: boolean;
  search?: string;
  parentID?: string;
};

// ---------------------------------------------------------------------------
// The shim
// ---------------------------------------------------------------------------

async function buildProviderList(): Promise<ProviderList> {
  const [providers, models] = await Promise.all([v2Client.provider.list(), v2Client.model.list()]);

  const byProvider = new Map<string, Record<string, Model>>();
  for (const model of models.data) {
    const list = byProvider.get(model.providerID) ?? {};
    list[model.modelID] = adaptModel(model);
    byProvider.set(model.providerID, list);
  }

  const mapped: Provider[] = providers.data.map((provider: V2ProviderInfo) => ({
    id: provider.id,
    name: provider.name,
    models: byProvider.get(provider.id) ?? {},
  }));

  return { providers: mapped, default: {} };
}

async function listCommands(directory?: string): Promise<Command[]> {
  const location = directory ? { directory } : undefined;
  const [commands, skills] = await Promise.all([
    v2Client.command.list(location ? { location } : undefined),
    v2Client.skill.list(location ? { location } : undefined),
  ]);

  const mappedCommands: Command[] = commands.data.map((command) => ({
    name: command.name,
    description: command.description,
    source: "command",
  }));

  const mappedSkills: Command[] = skills.data.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: "skill",
  }));

  return [...mappedCommands, ...mappedSkills];
}

function switchAgentAndModel(input: PromptRequest): Promise<void> {
  const steps: Promise<void>[] = [];

  if (input.agent) {
    steps.push(v2Client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }));
  }

  if (input.model?.providerID && input.model?.modelID) {
    steps.push(
      v2Client.session.switchModel({
        sessionID: input.sessionID,
        model: {
          id: input.model.modelID,
          providerID: input.model.providerID,
          variant: input.variant,
        },
      }),
    );
  }

  return Promise.all(steps).then(() => undefined);
}

function buildPromptText(input: PromptRequest): string {
  const parts = input.parts ?? [];
  const texts = parts
    .filter((part) => part.type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .filter((text) => text.length > 0);

  if (input.system) {
    texts.unshift(input.system);
  }

  return texts.join("\n");
}

function buildPromptFiles(
  input: PromptRequest,
): Array<{ uri: string; name?: string }> | undefined {
  const files = (input.parts ?? [])
    .filter((part) => part.type === "file")
    .map((part) => {
      const file = part as unknown as FilePartInput;
      return { uri: file.url, name: file.filename };
    });

  return files.length > 0 ? files : undefined;
}

async function enqueuePrompt(input: PromptRequest): Promise<void> {
  await switchAgentAndModel(input);
  const files = buildPromptFiles(input);
  await v2Client.session.prompt({
    sessionID: input.sessionID,
    id: input.messageID,
    text: buildPromptText(input),
    files,
  });
}

async function findNewAssistantReply(
  sessionID: string,
  knownAssistantIds: Set<string>,
  timeoutMs: number,
): Promise<SessionMessageAssistant | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await v2Client.message.list({ sessionID, order: "desc", limit: 10 });
      const reply = response.data.find(
        (message): message is SessionMessageAssistant =>
          message.type === "assistant" && !knownAssistantIds.has(message.id),
      );
      if (reply && (reply.time.completed || reply.finish || reply.error)) {
        return reply;
      }
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  return null;
}

export const opencodeClient = {
  session: {
    async get(input: { sessionID: string; directory?: string }): Promise<V1Result<Session>> {
      return wrap(async () => adaptSession(await v2Client.session.get({ sessionID: input.sessionID })));
    },

    async list(input: SessionListInput = {}): Promise<V1Result<Session[]>> {
      return wrap(async () => {
        const response = await v2Client.session.list({
          limit: input.limit,
          order: input.order,
          search: input.search,
          parentID: input.roots ? null : input.parentID,
          directory: input.directory,
        });
        return response.data.map(adaptSession);
      });
    },

    async create(input: SessionCreateInput = {}): Promise<V1Result<Session>> {
      return wrap(async () => {
        const response = await v2Client.session.create({
          title: input.title,
          parentID: input.parentID,
          permissions: permissionRulesToV2(input.permission),
          location: input.directory ? { directory: input.directory } : undefined,
        });
        return adaptSession(response);
      });
    },

    async update(input: {
      sessionID: string;
      directory?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
    }): Promise<V1Result<Session>> {
      return wrap(async () => {
        await v2Client.session.update({
          sessionID: input.sessionID,
          title: input.title,
          metadata: input.metadata as never,
          permissions: permissionRulesToV2(input.permission),
        });
        return adaptSession(await v2Client.session.get({ sessionID: input.sessionID }));
      });
    },

    async delete(input: { sessionID: string }): Promise<V1Result<boolean>> {
      return wrap(async () => {
        await v2Client.session.remove({ sessionID: input.sessionID });
        return true;
      });
    },

    async messages(input: {
      sessionID: string;
      directory?: string;
      limit?: number;
    }): Promise<V1Result<Array<{ info: Message; parts: Part[] }>>> {
      return wrap(async () => {
        const response = await v2Client.message.list({
          sessionID: input.sessionID,
          limit: input.limit,
          order: "asc",
        });
        return response.data
          .map((message) => adaptMessage(message, input.sessionID))
          .filter((entry): entry is { info: Message; parts: Part[] } => entry !== null);
      });
    },

    async promptAsync(input: PromptRequest): Promise<V1Result<unknown>> {
      return wrap(async () => {
        await enqueuePrompt(input);
        return {};
      });
    },

    async prompt(input: PromptRequest): Promise<V1Result<{ info: Message; parts: Part[] }>> {
      return wrap(async () => {
        const knownAssistantIds = new Set<string>();
        try {
          const existing = await v2Client.message.list({
            sessionID: input.sessionID,
            order: "asc",
            type: "assistant",
          });
          for (const message of existing.data) {
            knownAssistantIds.add(message.id);
          }
        } catch {
          // no existing history
        }

        await enqueuePrompt(input);

        const reply = await findNewAssistantReply(
          input.sessionID,
          knownAssistantIds,
          config.bot.scheduledTaskExecutionTimeoutMinutes * 60 * 1000,
        );

        if (!reply) {
          throw new Error("Timed out waiting for an assistant reply");
        }

        const adapted = adaptMessage(reply, input.sessionID);
        if (!adapted) {
          throw new Error("Failed to read assistant reply");
        }
        return adapted;
      });
    },

    async abort(
      input: { sessionID: string; directory?: string },
      options?: { signal?: AbortSignal },
    ): Promise<V1Result<boolean>> {
      return wrap(async () => {
        const response = await v2Client.session.interrupt(
          { sessionID: input.sessionID },
          { signal: options?.signal },
        );
        return response.interrupted;
      });
    },

    async status(_input?: { directory?: string }): Promise<
      V1Result<Record<string, { type: string }>>
    > {
      return wrap(async () => {
        const active = await v2Client.session.active();
        const statuses: Record<string, { type: string }> = {};
        for (const sessionID of Object.keys(active)) {
          statuses[sessionID] = { type: "busy" };
        }
        return statuses;
      });
    },

    async summarize(input: {
      sessionID: string;
      directory?: string;
      providerID?: string;
      modelID?: string;
    }): Promise<V1Result<boolean>> {
      return wrap(async () => {
        await v2Client.session.compact({ sessionID: input.sessionID });
        return true;
      });
    },

    async diff(input: { sessionID: string; directory?: string }): Promise<V1Result<FileDiff[]>> {
      return wrap(async () => {
        const diffs = await v2Client.session.diff({ sessionID: input.sessionID });
        return diffs.map((diff: FileDiffInfo): FileDiff => ({
          file: diff.file,
          before: "",
          after: "",
          additions: diff.additions,
          deletions: diff.deletions,
        }));
      });
    },

    async command(input: {
      sessionID: string;
      directory?: string;
      command: string;
      arguments?: string;
      agent?: string;
      model?: string;
      variant?: string;
    }): Promise<V1Result<unknown>> {
      return wrap(async () => {
        const model = parseModelString(input.model);
        await switchAgentAndModel({
          sessionID: input.sessionID,
          agent: input.agent,
          model,
          variant: input.variant,
        });
        await v2Client.session.command({
          sessionID: input.sessionID,
          name: input.command,
          text: input.arguments ?? "",
        });
        return {};
      });
    },
  },

  project: {
    async list(): Promise<V1Result<Project[]>> {
      return wrap(async () => {
        const projects = await v2Client.project.list();
        return projects.map((project) =>
          adaptProject({
            id: project.id,
            canonical: project.canonical,
            name: project.name,
            time: project.time,
          }),
        );
      });
    },
  },

  command: {
    async list(input: { directory?: string } = {}): Promise<V1Result<Command[]>> {
      return wrap(() => listCommands(input.directory));
    },
  },

  config: {
    async providers(): Promise<V1Result<ProviderList>> {
      return wrap(() => buildProviderList());
    },
  },

  app: {
    async agents(input?: { directory?: string }): Promise<V1Result<Agent[]>> {
      return wrap(async () => {
        const response = await v2Client.agent.list(
          input?.directory ? { location: { directory: input.directory } } : undefined,
        );
        return response.data.map(adaptAgent);
      });
    },
  },

  mcp: {
    async status(input?: { directory?: string }): Promise<
      V1Result<Record<string, { status: string; error?: string }>>
    > {
      return wrap(async () => {
        const response: McpListOutput = await v2Client.mcp.list(
          input?.directory ? { location: { directory: input.directory } } : undefined,
        );
        const statuses: Record<string, { status: string; error?: string }> = {};
        for (const server of response.data) {
          statuses[server.name] = server.status as { status: string; error?: string };
        }
        return statuses;
      });
    },

    async connect(input: { name: string; directory?: string }): Promise<V1Result<unknown>> {
      return wrap(async () => {
        await v2Client.mcp.connect({
          server: input.name,
          location: input.directory ? { directory: input.directory } : undefined,
        });
        return {};
      });
    },

    async disconnect(input: { name: string; directory?: string }): Promise<V1Result<unknown>> {
      return wrap(async () => {
        await v2Client.mcp.disconnect({
          server: input.name,
          location: input.directory ? { directory: input.directory } : undefined,
        });
        return {};
      });
    },
  },

  permission: {
    async reply(input: {
      requestID: string;
      sessionID?: string;
      directory?: string;
      reply: PermissionReply;
      message?: string;
    }): Promise<V1Result<unknown>> {
      return wrap(async () => {
        const sessionID = input.sessionID ?? permissionSessionById.get(input.requestID);
        if (!sessionID) {
          throw new Error(`Unknown session for permission request ${input.requestID}`);
        }
        await v2Client.permission.reply({
          sessionID,
          requestID: input.requestID,
          decision: input.reply,
          message: input.message,
        });
        permissionSessionById.delete(input.requestID);
        return {};
      });
    },
  },

  question: {
    async reply(input: {
      requestID: string;
      sessionID?: string;
      directory?: string;
      answers: string[][];
    }): Promise<V1Result<unknown>> {
      return wrap(async () => {
        const sessionID = input.sessionID ?? formSessionById.get(input.requestID);
        if (!sessionID) {
          throw new Error(`Unknown session for question ${input.requestID}`);
        }

        const fieldKeys = formFieldKeysById.get(input.requestID) ?? [];
        const answer: Record<string, string | string[]> = {};
        input.answers.forEach((values, index) => {
          const key = fieldKeys[index] ?? String(index);
          answer[key] = values.length <= 1 ? (values[0] ?? "") : values;
        });

        await v2Client.session.form.reply({
          sessionID,
          formID: input.requestID,
          answer,
        });
        formSessionById.delete(input.requestID);
        formFieldKeysById.delete(input.requestID);
        return {};
      });
    },
  },

  // v1 exposed server filesystem paths via `path.get`. The v2 server does not,
  // so synthesize the same view from the local environment; the session cache
  // treats a missing API as "no extra roots".
  path: {
    async get(): Promise<V1Result<{ home?: string; state?: string }>> {
      return {
        data: {
          home: os.homedir(),
          state: process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
        },
        error: undefined,
      };
    },
  },
};

// Liveness probe against the v2 `/api/info` endpoint via the v2 client.
export async function fetchServerInfo(): Promise<{
  data?: { healthy: boolean; version?: string };
  error?: unknown;
}> {
  try {
    const info = await v2Client.server.info();
    return { data: { healthy: true, version: info.version } };
  } catch (error) {
    return { error };
  }
}

export function sessionCreateInDirectory(
  directory: string,
  extra?: Omit<SessionCreateInput, "directory">,
): Promise<V1Result<Session>> {
  return opencodeClient.session.create({ ...extra, directory });
}
