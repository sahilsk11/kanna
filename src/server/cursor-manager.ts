import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { DEFAULT_CURSOR_MODEL, type AgentProvider, type ContextWindowUsageSnapshot, type TodoItem, type TranscriptEntry } from "../shared/types"
import { AsyncQueue } from "./async-queue"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import {
  type CancelParams,
  type InitializeParams,
  type JsonRpcResponse,
  type ListSessionsParams,
  type ListSessionsResponse,
  type LoadSessionParams,
  type LoadSessionResponse,
  type NewSessionParams,
  type NewSessionResponse,
  type PlanEntry,
  type PromptParams,
  type PromptResponse,
  type SessionInfo,
  type SessionUpdate,
  type SessionUpdateNotification,
  type ToolCallUpdatePayload,
  type Usage,
} from "./hermes-acp-protocol"

export interface CursorAcpProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export type SpawnCursorAcp = (cwd: string) => CursorAcpProcess

export interface StartCursorSessionArgs {
  chatId: string
  cwd: string
  sessionToken: string | null
  pendingForkSessionToken?: string | null
}

export interface StartCursorTurnArgs {
  chatId: string
  content: string
  model?: string
  planMode?: boolean
}

interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

interface PendingTurn {
  queue: AsyncQueue<HarnessEvent>
  startedToolIds: Set<string>
  resolved: boolean
  hasVisibleOutput: boolean
  allowPermissionRequests: boolean
}

interface SessionContext {
  chatId: string
  cwd: string
  child: CursorAcpProcess
  pendingRequests: Map<string | number, PendingRequest<unknown>>
  pendingTurn: PendingTurn | null
  sessionToken: string | null
  currentModel: string
  currentMode: CursorMode
  stderrLines: string[]
  closed: boolean
}

type CursorMode = "agent" | "plan"

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

function cursorSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "cursor",
    model,
    tools: ["Cursor ACP"],
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
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

function normalizeUsageFromPrompt(usage: Usage | null | undefined): ContextWindowUsageSnapshot | null {
  const record = asRecord(usage)
  if (!record) return null
  const inputTokens = asNumber(record.inputTokens) ?? 0
  const outputTokens = asNumber(record.outputTokens) ?? 0
  const cachedInputTokens = asNumber(record.cachedReadTokens)
  const reasoningOutputTokens = asNumber(record.thoughtTokens)
  const totalTokens = asNumber(record.totalTokens)
  const usedTokens = totalTokens ?? inputTokens + outputTokens
  if (usedTokens <= 0) return null
  return {
    usedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
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

function planToolCall(entries: PlanEntry[]): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId: `cursor-plan-${randomUUID()}`,
      input: {
        todos: planEntriesToTodos(entries),
      },
      rawInput: { entries },
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

function toolCallEntry(update: ToolCallUpdatePayload): TranscriptEntry {
  const payload = toolPayload(update)
  const command = asString(payload.command)
  const path = asString(payload.path)
  const toolId = update.toolCallId

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
          description: asString(payload.description),
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
        input: { filePath: path },
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
          pattern: asString(payload.pattern) ?? update.title ?? "Search",
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
      toolName: update.title?.trim() || update.kind || "CursorTool",
      toolId,
      input: { payload },
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
  if (update.rawOutput !== undefined && update.rawOutput !== null) return update.rawOutput
  if (update.content?.length) return update.content.map(stringifyToolContent).filter(Boolean).join("\n")
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

function choosePermissionOutcome(options: unknown[], allow: boolean) {
  const permissionOptions = options.filter((option): option is Record<string, unknown> => Boolean(asRecord(option)))
  if (allow) {
    const allowOption = permissionOptions.find((option) => option.optionId === "allow-once")
      ?? permissionOptions.find((option) => option.optionId === "allow-always")
      ?? permissionOptions.find((option) => `${option.kind ?? ""} ${option.optionId ?? ""}`.toLowerCase().includes("allow"))
    if (typeof allowOption?.optionId === "string") {
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } }
    }
  }
  const reject = permissionOptions.find((option) => option.optionId === "reject-once")
    ?? permissionOptions.find((option) => `${option.kind ?? ""} ${option.optionId ?? ""}`.toLowerCase().includes("reject"))
    ?? permissionOptions.find((option) => `${option.kind ?? ""} ${option.optionId ?? ""}`.toLowerCase().includes("deny"))
  if (typeof reject?.optionId === "string") {
    return { outcome: { outcome: "selected", optionId: reject.optionId } }
  }
  return { outcome: { outcome: "cancelled" } }
}

function cursorModeFromPlanMode(planMode: boolean | undefined): CursorMode {
  return planMode ? "plan" : "agent"
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  const record = asRecord(value)
  return Boolean(record && "id" in record && !("method" in record))
}

function isClientRequest(value: unknown): value is { id: string | number; method: string; params?: unknown } {
  const record = asRecord(value)
  return Boolean(record && "id" in record && typeof record.method === "string")
}

function isSessionUpdateNotification(value: unknown): value is SessionUpdateNotification {
  const record = asRecord(value)
  const params = asRecord(record?.params)
  const update = asRecord(params?.update)
  return record?.method === "session/update" && typeof params?.sessionId === "string" && typeof update?.sessionUpdate === "string"
}

export class CursorManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly spawnProcess: SpawnCursorAcp

  constructor(args: { spawnProcess?: SpawnCursorAcp } = {}) {
    this.spawnProcess = args.spawnProcess ?? ((cwd) =>
      spawn("agent", ["acp"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as unknown as CursorAcpProcess)
  }

  async startSession(args: StartCursorSessionArgs): Promise<string | undefined> {
    if (args.pendingForkSessionToken) {
      throw new Error("Cursor ACP sessions cannot be forked yet")
    }

    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && existing.sessionToken === args.sessionToken) {
      return existing.sessionToken ?? undefined
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
      currentModel: DEFAULT_CURSOR_MODEL,
      currentMode: "agent",
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(args.chatId, context)
    this.attachListeners(context)

    await this.initialize(context)

    if (args.sessionToken) {
      await this.sendRequest<LoadSessionResponse>(context, "session/load", {
        cwd: args.cwd,
        sessionId: args.sessionToken,
        mcpServers: [],
      } satisfies LoadSessionParams)
      context.sessionToken = args.sessionToken
    } else {
      const response = await this.sendRequest<NewSessionResponse>(context, "session/new", {
        cwd: args.cwd,
        mcpServers: [],
      } satisfies NewSessionParams)
      context.sessionToken = response.sessionId
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
      currentModel: DEFAULT_CURSOR_MODEL,
      currentMode: "agent",
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(chatId, context)
    this.attachListeners(context)

    try {
      await this.initialize(context)
      const response = await this.sendRequest<ListSessionsResponse>(context, "session/list", {
        cwd: args.cwd ?? null,
        cursor: args.cursor ?? null,
      } satisfies ListSessionsParams)
      return response.sessions
    } finally {
      this.stopSession(chatId)
    }
  }

  async startTurn(args: StartCursorTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error("Cursor turn is already running")
    }
    if (!context.sessionToken) {
      throw new Error("Cursor session not initialized")
    }

    const queue = new AsyncQueue<HarnessEvent>()
    queue.push({ type: "session_token", sessionToken: context.sessionToken })
    queue.push({ type: "transcript", entry: cursorSystemInitEntry(args.model ?? DEFAULT_CURSOR_MODEL) })

    const pendingTurn: PendingTurn = {
      queue,
      startedToolIds: new Set(),
      resolved: false,
      hasVisibleOutput: false,
      allowPermissionRequests: !args.planMode,
    }
    context.pendingTurn = pendingTurn

    try {
      await this.ensureMode(context, cursorModeFromPlanMode(args.planMode))
      await this.ensureModel(context, args.model)
    } catch (error) {
      this.failTurn(context, errorMessage(error))
      return this.turnHandle(context, pendingTurn)
    }

    void this.sendRequest<PromptResponse>(context, "session/prompt", {
      sessionId: context.sessionToken,
      messageId: randomUUID(),
      prompt: [{ type: "text", text: args.content }],
    } satisfies PromptParams)
      .then((response) => {
        this.handlePromptCompleted(context, response)
      })
      .catch((error) => {
        if (context.pendingTurn === pendingTurn && !pendingTurn.resolved) {
          this.failTurn(context, errorMessage(error))
        }
      })

    return this.turnHandle(context, pendingTurn)
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    context.closed = true
    context.pendingTurn?.queue.finish()
    context.pendingTurn = null
    this.sessions.delete(chatId)
    try {
      context.child.kill("SIGKILL")
    } catch {
      // Ignore kill failures.
    }
  }

  stopAll() {
    for (const chatId of [...this.sessions.keys()]) {
      this.stopSession(chatId)
    }
  }

  private async initialize(context: SessionContext) {
    await this.sendRequest(context, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "kanna_desktop", title: "Kanna", version: "0.1.0" },
      clientCapabilities: {
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    } satisfies InitializeParams)
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed) {
      throw new Error("Cursor session not started")
    }
    return context
  }

  private turnHandle(context: SessionContext, pendingTurn: PendingTurn): HarnessTurn {
    return {
      provider: "cursor" satisfies AgentProvider,
      stream: pendingTurn.queue,
      interrupt: async () => {
        if (context.pendingTurn !== pendingTurn || pendingTurn.resolved) return
        pendingTurn.resolved = true
        if (context.sessionToken) {
          this.writeMessage(context, {
            jsonrpc: "2.0",
            method: "session/cancel",
            params: {
              sessionId: context.sessionToken,
            } satisfies CancelParams,
          })
        }
        pendingTurn.queue.finish()
        context.pendingTurn = null
      },
      close: () => {},
    }
  }

  private async ensureMode(context: SessionContext, mode: CursorMode) {
    if (context.currentMode === mode || !context.sessionToken) return
    await this.sendRequest(context, "session/set_mode", {
      sessionId: context.sessionToken,
      modeId: mode,
    })
    context.currentMode = mode
  }

  private async ensureModel(context: SessionContext, model: string | undefined) {
    context.currentModel = model?.trim() || DEFAULT_CURSOR_MODEL
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
        const message = context.stderrLines.at(-1) || `Cursor ACP exited with code ${code ?? 1}`
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

  private handleClientRequest(context: SessionContext, request: { id: string | number; method: string; params?: unknown }) {
    if (request.method === "session/request_permission") {
      const params = asRecord(request.params)
      const options = Array.isArray(params?.options) ? params.options : []
      const allow = context.pendingTurn?.allowPermissionRequests ?? false
      this.writeMessage(context, {
        jsonrpc: "2.0",
        id: request.id,
        result: choosePermissionOutcome(options, allow),
      })
      return
    }

    this.writeMessage(context, {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported Cursor ACP client request: ${request.method}`,
      },
    })
  }

  private handleNotification(context: SessionContext, notification: SessionUpdateNotification) {
    if (context.sessionToken && notification.params.sessionId !== context.sessionToken) return
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return

    const update = notification.params.update
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textFromContentBlock((update as { content?: unknown }).content)
        if (!text) return
        pendingTurn.hasVisibleOutput = true
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({ kind: "assistant_text", text }),
        })
        return
      }
      case "agent_thought_chunk": {
        const text = textFromContentBlock((update as { content?: unknown }).content)
        if (!text) return
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({ kind: "assistant_text", text, hidden: true }),
        })
        return
      }
      case "tool_call":
      case "tool_call_update":
        this.handleToolUpdate(pendingTurn, update as ToolCallUpdatePayload)
        return
      case "plan": {
        const entries = Array.isArray((update as { entries?: unknown }).entries)
          ? (update as { entries: PlanEntry[] }).entries
          : []
        if (entries.length === 0) return
        pendingTurn.hasVisibleOutput = true
        pendingTurn.queue.push({ type: "transcript", entry: planToolCall(entries) })
        return
      }
      case "usage_update": {
        const usage = normalizeUsageFromUpdate(update)
        if (!usage) return
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({ kind: "context_window_updated", usage }),
        })
        return
      }
      default:
        return
    }
  }

  private handleToolUpdate(pendingTurn: PendingTurn, update: ToolCallUpdatePayload) {
    if (!pendingTurn.startedToolIds.has(update.toolCallId)) {
      pendingTurn.startedToolIds.add(update.toolCallId)
      pendingTurn.hasVisibleOutput = true
      pendingTurn.queue.push({ type: "transcript", entry: toolCallEntry(update) })
    }

    if (update.status === "completed" || update.status === "failed") {
      pendingTurn.queue.push({ type: "transcript", entry: toolResultEntry(update) })
    }
  }

  private handlePromptCompleted(context: SessionContext, response: PromptResponse) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return
    pendingTurn.resolved = true

    const usage = normalizeUsageFromPrompt(response.usage)
    if (usage) {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({ kind: "context_window_updated", usage }),
      })
    }

    const noOutputMessage = this.getNoOutputErrorMessage(context, pendingTurn, response)
    const isCancelled = response.stopReason === "cancelled"
    const isRefusal = response.stopReason === "refusal"
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

  private getNoOutputErrorMessage(context: SessionContext, pendingTurn: PendingTurn, response: PromptResponse) {
    if (response.stopReason !== "end_turn") return null
    if (pendingTurn.hasVisibleOutput) return null
    const stderr = context.stderrLines.at(-1)
    return stderr
      ? `Cursor returned no output. Last Cursor log: ${stderr}`
      : "Cursor returned no output. Check Cursor authentication and provider configuration."
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
