// Minimal typed ACP subset used by the Hermes harness adapter.
// Field names intentionally follow ACP's JSON aliases.

export type HermesAcpRequestId = string | number

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc?: "2.0"
  id: HermesAcpRequestId
  result?: TResult
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

export interface InitializeParams {
  protocolVersion: number
  clientInfo: {
    name: string
    title?: string
    version: string
  }
  clientCapabilities: {
    auth?: {
      terminal?: boolean
    }
    fs?: {
      readTextFile?: boolean
      writeTextFile?: boolean
    }
    terminal?: boolean
  }
}

export interface InitializeResponse {
  protocolVersion: number
  agentInfo?: {
    name: string
    title?: string
    version: string
  } | null
  agentCapabilities?: {
    prompt?: unknown
    mcp?: unknown
    session?: unknown
  } | null
  authMethods?: unknown[]
}

export interface NewSessionParams {
  cwd: string
  mcpServers: unknown[]
}

export interface NewSessionResponse {
  sessionId: string
  models?: unknown
  modes?: unknown
  configOptions?: unknown[]
}

export interface LoadSessionParams {
  cwd: string
  sessionId: string
  mcpServers: unknown[]
}

export interface LoadSessionResponse {
  models?: unknown
  modes?: unknown
  configOptions?: unknown[]
}

export interface ResumeSessionParams {
  cwd: string
  sessionId: string
  mcpServers?: unknown[] | null
}

export type ResumeSessionResponse = LoadSessionResponse

export interface ForkSessionParams {
  cwd: string
  sessionId: string
  mcpServers?: unknown[] | null
}

export interface ForkSessionResponse extends LoadSessionResponse {
  sessionId: string
}

export interface ListSessionsParams {
  cwd?: string | null
  cursor?: string | null
}

export interface SessionInfo {
  sessionId: string
  cwd: string
  title?: string | null
  updatedAt?: string | null
}

export interface ListSessionsResponse {
  sessions: SessionInfo[]
  nextCursor?: string | null
}

export interface TextContentBlock {
  type: "text"
  text: string
}

export interface ImageContentBlock {
  type: "image"
  data?: string
  uri?: string
  mimeType: string
}

export interface ResourceContentBlock {
  type: "resource_link"
  uri: string
  name: string
  title?: string | null
  mimeType?: string | null
}

export interface EmbeddedResourceContentBlock {
  type: "resource"
  resource: {
    uri: string
    text?: string
    blob?: string
    mimeType?: string | null
  }
}

export type PromptContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ResourceContentBlock
  | EmbeddedResourceContentBlock

export interface PromptParams {
  sessionId: string
  prompt: PromptContentBlock[]
  messageId?: string
}

export type PromptStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  thoughtTokens?: number | null
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
}

export interface PromptResponse {
  stopReason: PromptStopReason
  usage?: Usage | null
  userMessageId?: string | null
}

export interface CancelParams {
  sessionId: string
}

export interface TextContent {
  type: "text"
  text: string
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

export interface ToolCallContent {
  type?: string
  content?: TextContent | TextContent[]
  text?: string
  [key: string]: unknown
}

export interface ToolCallUpdatePayload {
  sessionUpdate: "tool_call" | "tool_call_update"
  toolCallId: string
  title?: string
  kind?: ToolKind | null
  status?: ToolCallStatus | null
  rawInput?: unknown
  rawOutput?: unknown
  content?: ToolCallContent[] | null
  locations?: unknown[] | null
}

export interface PlanEntry {
  content: string
  priority: "high" | "medium" | "low"
  status: "pending" | "in_progress" | "completed"
}

export interface SessionUpdatePayloadBase {
  sessionUpdate: string
}

export interface AgentMessageChunk extends SessionUpdatePayloadBase {
  sessionUpdate: "agent_message_chunk"
  content: PromptContentBlock
  messageId?: string | null
}

export interface AgentThoughtChunk extends SessionUpdatePayloadBase {
  sessionUpdate: "agent_thought_chunk"
  content: PromptContentBlock
  messageId?: string | null
}

export interface UserMessageChunk extends SessionUpdatePayloadBase {
  sessionUpdate: "user_message_chunk"
  content: PromptContentBlock
  messageId?: string | null
}

export interface AgentPlanUpdate extends SessionUpdatePayloadBase {
  sessionUpdate: "plan"
  entries: PlanEntry[]
}

export interface UsageUpdate extends SessionUpdatePayloadBase {
  sessionUpdate: "usage_update"
  size: number
  used: number
}

export interface SessionInfoUpdate extends SessionUpdatePayloadBase {
  sessionUpdate: "session_info_update"
  title?: string | null
  updatedAt?: string | null
}

export type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCallUpdatePayload
  | AgentPlanUpdate
  | UsageUpdate
  | SessionInfoUpdate
  | (SessionUpdatePayloadBase & Record<string, unknown>)

export interface SessionUpdateParams {
  sessionId: string
  update: SessionUpdate
}

export interface SessionUpdateNotification {
  method: "session/update"
  params: SessionUpdateParams
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"

export interface PermissionOption {
  optionId: string
  kind: PermissionOptionKind
  name: string
}

export interface RequestPermissionParams {
  sessionId: string
  toolCall: ToolCallUpdatePayload
  options: PermissionOption[]
}

export interface RequestPermissionRequest {
  id: HermesAcpRequestId
  method: "session/request_permission"
  params: RequestPermissionParams
}

export interface RequestPermissionResponse {
  outcome:
    | {
        outcome: "cancelled"
      }
    | {
        outcome: "selected"
        optionId: string
      }
}

export type ClientRequest = RequestPermissionRequest | {
  id: HermesAcpRequestId
  method: string
  params?: unknown
}

export type ClientNotification = SessionUpdateNotification | {
  method: string
  params?: unknown
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return Boolean(value) && typeof value === "object" && "id" in (value as Record<string, unknown>)
    && !("method" in (value as Record<string, unknown>))
}

export function isClientRequest(value: unknown): value is ClientRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.method === "string" && "id" in candidate
}

export function isSessionUpdateNotification(value: unknown): value is SessionUpdateNotification {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (candidate.method !== "session/update" || "id" in candidate) return false
  const params = candidate.params as Record<string, unknown> | undefined
  return Boolean(params) && typeof params === "object" && typeof params.sessionId === "string"
}
