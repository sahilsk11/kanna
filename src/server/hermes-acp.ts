import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { Readable, Writable } from "node:stream"
import { DEFAULT_HERMES_MODEL, DEFAULT_OPENCODE_MODEL, type AgentProvider, type ContextWindowUsageSnapshot, type TodoItem, type TranscriptEntry } from "../shared/types"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import {
  type CancelParams,
  type ClientRequest,
  type ForkSessionParams,
  type ForkSessionResponse,
  type HermesAcpRequestId,
  type InitializeParams,
  type JsonRpcResponse,
  type ListSessionsParams,
  type ListSessionsResponse,
  type NewSessionParams,
  type NewSessionResponse,
  type PermissionOption,
  type PlanEntry,
  type PromptParams,
  type PromptResponse,
  type RequestPermissionResponse,
  type ResumeSessionParams,
  type ResumeSessionResponse,
  type SetSessionModelParams,
  type SetSessionModelResponse,
  type SessionInfo,
  type SessionUpdate,
  type SessionUpdateNotification,
  type ToolCallUpdatePayload,
  type Usage,
  isClientRequest,
  isJsonRpcResponse,
  isSessionUpdateNotification,
} from "./hermes-acp-protocol"

export interface AcpProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export type SpawnAcp = (cwd: string) => AcpProcess

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const HERMES_ACP_BRIDGE_PATH = path.join(SERVER_DIR, "hermes-acp-bridge.cjs")

interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

interface PendingTurn {
  queue: AsyncQueue<HarnessEvent>
  startedToolIds: Set<string>
  resolved: boolean
  assistantText: string
  bufferedAssistantText: string
  hasVisibleOutput: boolean
}

interface SessionContext {
  chatId: string
  cwd: string
  child: AcpProcess
  pendingRequests: Map<HermesAcpRequestId, PendingRequest<unknown>>
  pendingTurn: PendingTurn | null
  sessionToken: string | null
  defaultModelId: string | null
  stderrLines: string[]
  closed: boolean
}

export interface StartHermesSessionArgs {
  chatId: string
  cwd: string
  sessionToken: string | null
  pendingForkSessionToken?: string | null
}

export interface StartHermesTurnArgs {
  chatId: string
  content: string
  model?: string
}

export interface GenerateHermesStructuredArgs {
  cwd: string
  prompt: string
}

interface AcpProviderConfig {
  provider: Extract<AgentProvider, "hermes" | "opencode">
  displayName: string
  defaultModel: string
  toolsLabel: string
  planToolIdPrefix: string
  fallbackToolName: string
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function acpSystemInitEntry(config: AcpProviderConfig, model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: config.provider,
    model,
    tools: [config.toolsLabel],
    agents: [],
    slashCommands: [],
    mcpServers: [],
  })
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function modelIdFromConfigOptions(configOptions: unknown): string | null {
  if (!Array.isArray(configOptions)) return null
  for (const option of configOptions) {
    const record = asRecord(option)
    if (!record) continue
    const id = typeof record.id === "string" ? record.id : ""
    const category = typeof record.category === "string" ? record.category : ""
    const currentValue = typeof record.currentValue === "string" ? record.currentValue.trim() : ""
    if (currentValue && (id === "model" || category === "model")) {
      return currentValue
    }
  }
  return null
}

function textFromContentBlock(content: unknown): string {
  const record = asRecord(content)
  if (!record) return ""
  if (record.type === "text" && typeof record.text === "string") {
    return record.text
  }
  const resource = asRecord(record.resource)
  if (record.type === "resource" && typeof resource?.text === "string") {
    return resource.text
  }
  return ""
}

function isHermesInternalAssistantText(text: string): boolean {
  const trimmed = text.trimStart()
  const looksLikeScratchpad =
    (
      /^(We need to|I need to|The user wants|Let me)\b/.test(trimmed) &&
      /\b(user|guidelines|should|No specific tool|Let's respond|I should|I can)\b/.test(trimmed)
    ) ||
    /\bis the exact response requested\b/i.test(trimmed)

  return (
    looksLikeScratchpad ||
    text.includes("<tool_call>") ||
    text.includes("</tool_call>") ||
    text.includes("<function=") ||
    text.includes("</function>")
  )
}

function normalizeUsageFromPrompt(usage: Usage | null | undefined): ContextWindowUsageSnapshot | null {
  if (!usage) return null
  const usedTokens = asNumber(usage.totalTokens)
  if (usedTokens === undefined || usedTokens <= 0) return null
  const inputTokens = asNumber(usage.inputTokens)
  const outputTokens = asNumber(usage.outputTokens)
  const reasoningOutputTokens = asNumber(usage.thoughtTokens)
  const cachedInputTokens = asNumber(usage.cachedReadTokens)
  return {
    usedTokens,
    ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  }
}

function normalizeUsageFromUpdate(update: SessionUpdate): ContextWindowUsageSnapshot | null {
  if (update.sessionUpdate !== "usage_update") return null
  const usedTokens = asNumber((update as { used?: unknown }).used)
  if (usedTokens === undefined || usedTokens <= 0) return null
  const maxTokens = asNumber((update as { size?: unknown }).size)
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  }
}

function todoStatus(status: PlanEntry["status"]): TodoItem["status"] {
  if (status === "completed") return "completed"
  if (status === "in_progress") return "in_progress"
  return "pending"
}

function planEntriesToTodos(entries: PlanEntry[]): TodoItem[] {
  return entries.map((entry) => ({
    content: entry.content,
    status: todoStatus(entry.status),
    activeForm: entry.content,
  }))
}

function planToolCall(config: AcpProviderConfig, entries: PlanEntry[]): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId: `${config.planToolIdPrefix}-${randomUUID()}`,
      input: {
        todos: planEntriesToTodos(entries),
      },
      rawInput: {
        entries,
      },
    },
  })
}

function toolPayload(update: ToolCallUpdatePayload): Record<string, unknown> {
  const rawInput = asRecord(update.rawInput)
  if (rawInput) return rawInput
  return {
    title: update.title,
    kind: update.kind,
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
  }
}

function toolNameFromUpdate(config: AcpProviderConfig, update: ToolCallUpdatePayload): string {
  const rawInput = asRecord(update.rawInput)
  const rawToolName = rawInput?.tool ?? rawInput?.toolName ?? rawInput?.name
  if (typeof rawToolName === "string" && rawToolName.trim()) return rawToolName.trim()
  return update.title?.trim() || update.kind || config.fallbackToolName
}

function toolCallEntry(config: AcpProviderConfig, update: ToolCallUpdatePayload): TranscriptEntry {
  const payload = toolPayload(update)
  const command = typeof payload.command === "string" ? payload.command : null
  const path = typeof payload.path === "string" ? payload.path : null
  const toolId = update.toolCallId
  const toolName = toolNameFromUpdate(config, update)

  if (update.kind === "execute" && command) {
    return timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "bash",
        toolName: "Bash",
        toolId,
        input: {
          command,
          description: typeof payload.description === "string" ? payload.description : undefined,
        },
        rawInput: payload,
      },
    })
  }

  if (update.kind === "read" && path) {
    return timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "read_file",
        toolName: "Read",
        toolId,
        input: {
          filePath: path,
        },
        rawInput: payload,
      },
    })
  }

  if (update.kind === "search") {
    return timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "grep",
        toolName: "Grep",
        toolId,
        input: {
          pattern: typeof payload.pattern === "string" ? payload.pattern : toolName,
        },
        rawInput: payload,
      },
    })
  }

  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "unknown_tool",
      toolName,
      toolId,
      input: {
        payload,
      },
      rawInput: payload,
    },
  })
}

function stringifyToolContent(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  const record = asRecord(value)
  if (record) {
    if (typeof record.text === "string") return record.text
    if (record.content) {
      if (Array.isArray(record.content)) {
        return record.content.map(stringifyToolContent).filter(Boolean).join("\n")
      }
      return stringifyToolContent(record.content)
    }
  }
  return JSON.stringify(value)
}

function toolResultContent(update: ToolCallUpdatePayload): unknown {
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return update.rawOutput
  }
  if (update.content?.length) {
    return update.content.map(stringifyToolContent).filter(Boolean).join("\n")
  }
  return ""
}

function toolResultEntry(update: ToolCallUpdatePayload): TranscriptEntry {
  return timestamped({
    kind: "tool_result",
    toolId: update.toolCallId,
    content: toolResultContent(update),
    isError: update.status === "failed",
  })
}

function chooseDenyOutcome(options: PermissionOption[]): RequestPermissionResponse {
  const deny = options.find((option) => option.optionId === "deny")
    ?? options.find((option) => option.kind.startsWith("reject"))
    ?? options.find((option) => option.optionId.toLowerCase().includes("deny"))
  if (deny) {
    return {
      outcome: {
        outcome: "selected",
        optionId: deny.optionId,
      },
    }
  }
  return {
    outcome: {
      outcome: "cancelled",
    },
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private done = false

  push(value: T) {
    if (this.done) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
      return
    }
    this.values.push(value)
  }

  finish() {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

export class HermesAcpManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly spawnProcess: SpawnAcp
  private readonly providerConfig: AcpProviderConfig

  constructor(args: { spawnProcess?: SpawnAcp; providerConfig?: Partial<AcpProviderConfig> } = {}) {
    this.providerConfig = {
      provider: "hermes",
      displayName: "Hermes",
      defaultModel: DEFAULT_HERMES_MODEL,
      toolsLabel: "Hermes ACP",
      planToolIdPrefix: "hermes-plan",
      fallbackToolName: "HermesTool",
      ...args.providerConfig,
    }
    this.spawnProcess = args.spawnProcess ?? ((cwd) =>
      spawn(process.execPath, [HERMES_ACP_BRIDGE_PATH], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as unknown as AcpProcess)
  }

  async startSession(args: StartHermesSessionArgs): Promise<string | undefined> {
    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && !args.pendingForkSessionToken && existing.sessionToken) {
      return existing.sessionToken
    }

    if (existing) {
      this.stopSession(args.chatId)
    }

    const child = this.spawnProcess(args.cwd)
    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: null,
      defaultModelId: null,
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(args.chatId, context)
    this.attachListeners(context)

    await this.sendRequest(context, "initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "kanna_desktop",
        title: "Kanna",
        version: "0.1.0",
      },
      clientCapabilities: {
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    } satisfies InitializeParams)

    if (args.pendingForkSessionToken) {
      const response = await this.sendRequest<ForkSessionResponse>(context, "session/fork", {
        cwd: args.cwd,
        sessionId: args.pendingForkSessionToken,
        mcpServers: [],
      } satisfies ForkSessionParams)
      context.sessionToken = response.sessionId || null
      context.defaultModelId = modelIdFromConfigOptions(response.configOptions)
    } else if (args.sessionToken) {
      const response = await this.sendRequest<ResumeSessionResponse>(context, "session/resume", {
        cwd: args.cwd,
        sessionId: args.sessionToken,
        mcpServers: [],
      } satisfies ResumeSessionParams)
      context.sessionToken = args.sessionToken
      context.defaultModelId = modelIdFromConfigOptions(response.configOptions)
    } else {
      const response = await this.sendRequest<NewSessionResponse>(context, "session/new", {
        cwd: args.cwd,
        mcpServers: [],
      } satisfies NewSessionParams)
      context.sessionToken = response.sessionId
      context.defaultModelId = modelIdFromConfigOptions(response.configOptions)
    }

    return context.sessionToken ?? undefined
  }

  async listSessions(args: { cwd?: string | null; cursor?: string | null } = {}): Promise<SessionInfo[]> {
    const chatId = `list-${randomUUID()}`
    const cwd = args.cwd ?? process.cwd()
    const child = this.spawnProcess(cwd)
    const context: SessionContext = {
      chatId,
      cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: null,
      defaultModelId: null,
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(chatId, context)
    this.attachListeners(context)

    try {
      await this.sendRequest(context, "initialize", {
        protocolVersion: 1,
        clientInfo: { name: "kanna_desktop", title: "Kanna", version: "0.1.0" },
        clientCapabilities: {
          auth: { terminal: false },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      } satisfies InitializeParams)
      const response = await this.sendRequest<ListSessionsResponse>(context, "session/list", {
        cwd: args.cwd ?? null,
        cursor: args.cursor ?? null,
      } satisfies ListSessionsParams)
      return response.sessions
    } finally {
      this.stopSession(chatId)
    }
  }

  async startTurn(args: StartHermesTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error(`${this.providerConfig.displayName} turn is already running`)
    }
    if (!context.sessionToken) {
      throw new Error(`${this.providerConfig.displayName} session not initialized`)
    }

    const queue = new AsyncQueue<HarnessEvent>()
    queue.push({ type: "session_token", sessionToken: context.sessionToken })
    queue.push({ type: "transcript", entry: acpSystemInitEntry(this.providerConfig, args.model ?? this.providerConfig.defaultModel) })

    const pendingTurn: PendingTurn = {
      queue,
      startedToolIds: new Set(),
      resolved: false,
      assistantText: "",
      bufferedAssistantText: "",
      hasVisibleOutput: false,
    }
    context.pendingTurn = pendingTurn

    void this.prepareTurn(context, args.model)
      .then((shouldPrompt) => {
        if (!shouldPrompt || context.pendingTurn !== pendingTurn || pendingTurn.resolved) {
          return null
        }
        return this.sendRequest<PromptResponse>(context, "session/prompt", {
          sessionId: context.sessionToken!,
          messageId: randomUUID(),
          prompt: [
            {
              type: "text",
              text: args.content,
            },
          ],
        } satisfies PromptParams)
      })
      .then((response) => {
        if (response) {
          this.handlePromptCompleted(context, response)
        }
      })
      .catch((error) => {
        if (context.pendingTurn === pendingTurn && !pendingTurn.resolved) {
          this.failTurn(context, errorMessage(error))
        }
      })

    return {
      provider: this.providerConfig.provider,
      stream: queue,
      interrupt: async () => {
        const pendingTurn = context.pendingTurn
        if (!pendingTurn || !context.sessionToken) return
        pendingTurn.resolved = true
        this.writeMessage(context, {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: context.sessionToken,
          } satisfies CancelParams,
        })
        pendingTurn.queue.finish()
        context.pendingTurn = null
      },
      close: () => {},
    }
  }

  async generateStructured(args: GenerateHermesStructuredArgs): Promise<string | null> {
    const chatId = `quick-${randomUUID()}`
    let turn: HarnessTurn | null = null
    let assistantText = ""
    let resultText = ""

    try {
      await this.startSession({
        chatId,
        cwd: args.cwd,
        sessionToken: null,
      })
      turn = await this.startTurn({
        chatId,
        content: args.prompt,
      })

      for await (const event of turn.stream) {
        if (event.type !== "transcript" || !event.entry) continue
        if (event.entry.kind === "assistant_text") {
          if (event.entry.hidden) continue
          assistantText += assistantText ? `\n${event.entry.text}` : event.entry.text
        }
        if (event.entry.kind === "result" && !event.entry.isError && event.entry.result.trim()) {
          resultText = event.entry.result
        }
      }

      const candidate = assistantText.trim() || resultText.trim()
      return candidate || null
    } finally {
      turn?.close()
      this.stopSession(chatId)
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    context.closed = true
    context.pendingTurn?.queue.finish()
    this.sessions.delete(chatId)
    try {
      context.child.kill("SIGKILL")
    } catch {
      // ignore kill failures
    }
  }

  stopAll() {
    for (const chatId of this.sessions.keys()) {
      this.stopSession(chatId)
    }
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed) {
      throw new Error(`${this.providerConfig.displayName} session not started`)
    }
    return context
  }

  private attachListeners(context: SessionContext) {
    const lines = createInterface({ input: context.child.stdout })
    void (async () => {
      for await (const line of lines) {
        const parsed = parseJsonLine(line)
        if (!parsed) continue

        if (isJsonRpcResponse(parsed)) {
          this.handleResponse(context, parsed)
          continue
        }

        if (isClientRequest(parsed)) {
          this.handleClientRequest(context, parsed)
          continue
        }

        if (isSessionUpdateNotification(parsed)) {
          this.handleNotification(context, parsed)
        }
      }
    })()

    const stderr = createInterface({ input: context.child.stderr })
    void (async () => {
      for await (const line of stderr) {
        if (line.trim()) {
          context.stderrLines.push(line.trim())
        }
      }
    })()

    context.child.on("error", (error) => {
      this.failContext(context, error.message)
    })

    context.child.on("close", (code) => {
      if (context.closed) return
      queueMicrotask(() => {
        if (context.closed) return
        const message = context.stderrLines.at(-1) || `${this.providerConfig.displayName} ACP exited with code ${code ?? 1}`
        this.failContext(context, message)
      })
    })
  }

  private handleResponse(context: SessionContext, response: JsonRpcResponse) {
    const pending = context.pendingRequests.get(response.id)
    if (!pending) return
    context.pendingRequests.delete(response.id)
    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message ?? "Unknown error"}`))
      return
    }
    pending.resolve(response.result)
  }

  private handleClientRequest(context: SessionContext, request: ClientRequest) {
    if (request.method === "session/request_permission") {
      const params = asRecord(request.params)
      const options = Array.isArray(params?.options) ? params.options as PermissionOption[] : []
      this.writeMessage(context, {
        jsonrpc: "2.0",
        id: request.id,
        result: chooseDenyOutcome(options),
      })
      return
    }

    this.writeMessage(context, {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported ACP client request: ${request.method}`,
      },
    })
  }

  private handleNotification(context: SessionContext, notification: SessionUpdateNotification) {
    if (context.sessionToken && notification.params.sessionId !== context.sessionToken) {
      return
    }
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return

    const update = notification.params.update
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textFromContentBlock((update as { content?: unknown }).content)
        if (!text) return
        const hidden = this.providerConfig.provider === "hermes" && isHermesInternalAssistantText(text)
        if (!hidden) {
          pendingTurn.assistantText += text
          pendingTurn.hasVisibleOutput = true
        }
        if (!hidden && this.providerConfig.provider === "opencode") {
          pendingTurn.bufferedAssistantText += text
          return
        }
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "assistant_text",
            text,
            ...(hidden ? { hidden: true } : {}),
          }),
        })
        return
      }
      case "agent_thought_chunk": {
        const text = textFromContentBlock((update as { content?: unknown }).content)
        if (!text) return
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "assistant_text",
            text,
            hidden: true,
          }),
        })
        return
      }
      case "tool_call":
      case "tool_call_update":
        this.flushBufferedAssistantText(pendingTurn)
        this.handleToolUpdate(pendingTurn, update as ToolCallUpdatePayload)
        return
      case "plan": {
        const entries = Array.isArray((update as { entries?: unknown }).entries)
          ? (update as { entries: PlanEntry[] }).entries
          : []
        if (entries.length === 0) return
        this.flushBufferedAssistantText(pendingTurn)
        pendingTurn.hasVisibleOutput = true
        pendingTurn.queue.push({
          type: "transcript",
          entry: planToolCall(this.providerConfig, entries),
        })
        return
      }
      case "usage_update": {
        const usage = normalizeUsageFromUpdate(update)
        if (!usage) return
        this.flushBufferedAssistantText(pendingTurn)
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "context_window_updated",
            usage,
          }),
        })
        return
      }
      default:
        return
    }
  }

  private flushBufferedAssistantText(pendingTurn: PendingTurn) {
    if (!pendingTurn.bufferedAssistantText) return
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "assistant_text",
        text: pendingTurn.bufferedAssistantText,
      }),
    })
    pendingTurn.bufferedAssistantText = ""
  }

  private handleToolUpdate(pendingTurn: PendingTurn, update: ToolCallUpdatePayload) {
    if (!pendingTurn.startedToolIds.has(update.toolCallId)) {
      pendingTurn.startedToolIds.add(update.toolCallId)
      pendingTurn.hasVisibleOutput = true
      pendingTurn.queue.push({
        type: "transcript",
        entry: toolCallEntry(this.providerConfig, update),
      })
    }

    if (update.status === "completed" || update.status === "failed") {
      pendingTurn.queue.push({
        type: "transcript",
        entry: toolResultEntry(update),
      })
    }
  }

  private handlePromptCompleted(context: SessionContext, response: PromptResponse) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return
    pendingTurn.resolved = true

    this.flushBufferedAssistantText(pendingTurn)

    const isCancelled = response.stopReason === "cancelled"
    const isRefusal = response.stopReason === "refusal"
    const noOutputMessage = this.getNoOutputErrorMessage(context, pendingTurn, response)

    const usage = normalizeUsageFromPrompt(response.usage)
    if (usage) {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "context_window_updated",
          usage,
        }),
      })
    }

    const isError = isRefusal || Boolean(noOutputMessage)
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: isCancelled ? "cancelled" : isError ? "error" : "success",
        isError,
        durationMs: 0,
        result: noOutputMessage ?? (isRefusal ? response.stopReason : ""),
      }),
    })
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  private async prepareTurn(context: SessionContext, model: string | undefined) {
    if (this.providerConfig.provider !== "opencode" || !model) return true
    if (!context.sessionToken) {
      throw new Error(`${this.providerConfig.displayName} session not initialized`)
    }
    const modelId = model === DEFAULT_OPENCODE_MODEL ? context.defaultModelId : model
    if (!modelId) return true
    await this.sendRequest<SetSessionModelResponse>(context, "session/set_model", {
      sessionId: context.sessionToken,
      modelId,
    } satisfies SetSessionModelParams)
    return true
  }

  private getNoOutputErrorMessage(
    context: SessionContext,
    pendingTurn: PendingTurn,
    response: PromptResponse
  ) {
    if (response.stopReason !== "end_turn") return null
    if (pendingTurn.hasVisibleOutput) return null
    const stderr = context.stderrLines.at(-1)
    return stderr
      ? `${this.providerConfig.displayName} returned no output. Last ${this.providerConfig.displayName} log: ${stderr}`
      : `${this.providerConfig.displayName} returned no output. Check ${this.providerConfig.displayName} authentication and provider configuration.`
  }

  private failTurn(context: SessionContext, message: string) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return
    pendingTurn.resolved = true
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: message,
      }),
    })
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  private failContext(context: SessionContext, message: string) {
    this.failTurn(context, message)
    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error(message))
    }
    context.pendingRequests.clear()
    context.closed = true
  }

  private async sendRequest<TResult>(context: SessionContext, method: string, params: unknown): Promise<TResult> {
    const id = randomUUID()
    const promise = new Promise<TResult>((resolve, reject) => {
      context.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    this.writeMessage(context, {
      jsonrpc: "2.0",
      id,
      method,
      params,
    })
    return await promise
  }

  private writeMessage(context: SessionContext, message: Record<string, unknown>) {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

export class OpenCodeAcpManager extends HermesAcpManager {
  constructor(args: { spawnProcess?: SpawnAcp } = {}) {
    super({
      spawnProcess: args.spawnProcess ?? ((cwd) =>
        spawn("opencode", ["acp"], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }) as unknown as AcpProcess),
      providerConfig: {
        provider: "opencode",
        displayName: "OpenCode",
        defaultModel: DEFAULT_OPENCODE_MODEL,
        toolsLabel: "OpenCode ACP",
        planToolIdPrefix: "opencode-plan",
        fallbackToolName: "OpenCodeTool",
      },
    })
  }
}
