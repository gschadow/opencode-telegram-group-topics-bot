/**
 * Local, V1-shaped domain types.
 *
 * The bot was originally written against the pre-`/api` opencode v1 surface
 * (`@opencode-ai/sdk`, `session.messages`, `message.part.updated`, ...). The v2
 * server exposes a different data model (`@opencode/client`). These types
 * describe the shapes the rest of the bot consumes; `src/opencode/client.ts`
 * and `src/opencode/events.ts` adapt the v2 responses/events into them.
 *
 * They intentionally mirror the v1 SDK generated types so existing call sites
 * keep compiling without churn.
 */

// ---------------------------------------------------------------------------
// Messages and parts
// ---------------------------------------------------------------------------

export type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};

export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end?: number };
};

export type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: unknown;
};

export type ToolStatePending = {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
};

export type ToolStateRunning = {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: { start: number };
};

export type ToolStateCompleted = {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number; compacted?: number };
  attachments?: FilePart[];
};

export type ToolStateError = {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
};

export type StepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
};

export type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

export type SubtaskPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  command?: string;
};

export type SnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "snapshot";
  snapshot: string;
};

export type PatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: string[];
};

export type AgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "agent";
  name: string;
  source?: { value: string; start: number; end: number };
};

export type RetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "retry";
  attempt: number;
  error: unknown;
  time: { created: number };
};

export type CompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  auto: boolean;
};

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SubtaskPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart;

export type MessageError = {
  name?: string;
  message?: string;
  data?: { message?: string };
};

export type UserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent?: string;
  model?: { providerID: string; modelID: string };
  system?: string;
  variant?: string;
};

export type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  error?: MessageError;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  finish?: string;
  summary?: boolean;
};

export type Message = UserMessage | AssistantMessage;

// ---------------------------------------------------------------------------
// Sessions, projects, providers, agents, commands, mcp
// ---------------------------------------------------------------------------

export type Session = {
  id: string;
  directory: string;
  title: string;
  parentID?: string;
  time: { created: number; updated: number; [key: string]: unknown };
  metadata?: Record<string, unknown>;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  [key: string]: unknown;
};

export type Project = {
  id: string;
  worktree: string;
  name?: string;
  time?: { created?: number; updated?: number; [key: string]: unknown };
  [key: string]: unknown;
};

export type ModelCapabilities = {
  temperature: boolean;
  reasoning: boolean;
  attachment: boolean;
  toolcall: boolean;
  interleaved: boolean;
  input: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
  output: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
};

export type Model = {
  id: string;
  providerID: string;
  name: string;
  capabilities: ModelCapabilities;
  variants?: Record<string, { disabled?: boolean }>;
  limit: { context: number; output: number };
  cost?: { input: number; output: number; cache?: { read: number; write: number } };
  [key: string]: unknown;
};

export type Provider = {
  id: string;
  name: string;
  models: Record<string, Model>;
  [key: string]: unknown;
};

export type ProviderList = {
  providers: Provider[];
  default: Record<string, string>;
};

export type Agent = {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden?: boolean;
  [key: string]: unknown;
};

export type Command = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  template?: string;
  subtask?: boolean;
  hints?: string[];
  [key: string]: unknown;
};

export type McpStatusConnected = { status: "connected" };
export type McpStatusDisabled = { status: "disabled" };
export type McpStatusFailed = { status: "failed"; error: string };
export type McpStatusNeedsAuth = { status: "needs_auth"; error?: string };
export type McpStatusNeedsClientRegistration = { status: "needs_client_registration"; error: string };

export type McpStatus =
  | McpStatusConnected
  | McpStatusDisabled
  | McpStatusFailed
  | McpStatusNeedsAuth
  | McpStatusNeedsClientRegistration;

export type McpStatusMap = Record<string, McpStatus>;

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export type PermissionReply = "once" | "always" | "reject";

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
};

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

// ---------------------------------------------------------------------------
// Prompt input parts
// ---------------------------------------------------------------------------

export type TextPartInput = {
  id?: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};

export type FilePartInput = {
  id?: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: unknown;
};

export type AgentPartInput = {
  id?: string;
  type: "agent";
  name: string;
  source?: { value: string; start: number; end: number };
};

export type SubtaskPartInput = {
  id?: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  command?: string;
};

export type PromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

// ---------------------------------------------------------------------------
// Events (the subset the bot consumes)
// ---------------------------------------------------------------------------

export type EventMessageUpdated = {
  type: "message.updated";
  properties: { info: Message };
};

export type EventMessagePartUpdated = {
  type: "message.part.updated";
  properties: { part: Part; delta?: string };
};

export type EventMessagePartDelta = {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: "text" | "reasoning";
    delta: string;
  };
};

export type EventSessionStatus = {
  type: "session.status";
  properties: {
    sessionID: string;
    status: SessionStatus & { [key: string]: unknown };
  };
};

export type EventSessionIdle = {
  type: "session.idle";
  properties: { sessionID: string };
};

export type EventSessionCompacted = {
  type: "session.compacted";
  properties: { sessionID: string };
};

export type EventSessionError = {
  type: "session.error";
  properties: { sessionID?: string; error?: MessageError };
};

export type EventSessionCreated = {
  type: "session.created";
  properties: { info: Session };
};

export type EventSessionUpdated = {
  type: "session.updated";
  properties: { info: Session };
};

export type EventSessionDeleted = {
  type: "session.deleted";
  properties: { info: Session };
};

export type EventQuestionAsked = {
  type: "question.asked";
  properties: QuestionRequest;
};

export type EventQuestionReplied = {
  type: "question.replied";
  properties: { sessionID: string; requestID: string; answers: string[][] };
};

export type EventQuestionRejected = {
  type: "question.rejected";
  properties: { sessionID: string; requestID: string };
};

export type EventPermissionAsked = {
  type: "permission.asked";
  properties: PermissionRequest;
};

export type EventPermissionReplied = {
  type: "permission.replied";
  properties: { sessionID: string; requestID: string; reply: PermissionReply };
};

export type EventSessionDiff = {
  type: "session.diff";
  properties: { sessionID: string; diff: FileDiff[] };
};

export type EventFileEdited = {
  type: "file.edited";
  properties: { file: string };
};

export type Event =
  | EventMessageUpdated
  | EventMessagePartUpdated
  | EventMessagePartDelta
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionCompacted
  | EventSessionError
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventPermissionAsked
  | EventPermissionReplied
  | EventSessionDiff
  | EventFileEdited;
