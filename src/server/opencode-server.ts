import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { DEFAULT_OPENCODE_MODEL, type AgentProvider, type TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import { AsyncQueue } from "./async-queue"
import type { HarnessEvent, HarnessTurn } from "./harness-types"

export interface OpenCodeServerProcess {
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export type SpawnOpenCodeServer = (cwd: string) => OpenCodeServerProcess

export interface StartOpenCodeSessionArgs {
  chatId: string
  cwd: string
  sessionToken: string | null
  pendingForkSessionToken?: string | null
}

export interface StartOpenCodeTurnArgs {
  chatId: string
  content: string
  model?: string
}

type FetchImpl = typeof fetch

interface PendingTurn {
  queue: AsyncQueue<HarnessEvent>
  resolved: boolean
  textByMessageId: Map<string, string>
  roleByMessageId: Map<string, string>
  completedMessages: Set<string>
  startedToolIds: Set<string>
  hasThinkingStatus: boolean
}

interface SessionContext {
  chatId: string
  cwd: string
  sessionToken: string
  pendingTurn: PendingTurn | null
  closed: boolean
}

interface ServerState {
  cwd: string
  baseUrl: string
  child: OpenCodeServerProcess | null
  abortController: AbortController
  ready: Promise<void>
  resolveReady: () => void
  stopped: boolean
}

type OpenCodeEvent =
  | { type: "server.connected" }
  | { type: "session.status"; sessionId: string; status: string }
  | { type: "session.idle"; sessionId: string }
  | { type: "session.error"; sessionId: string; message: string }
  | {
      type: "message.updated"
      sessionId: string
      messageId: string
      role: string
      timeEnd: number | null
      modelId?: string | null
      providerId?: string | null
    }
  | {
      type: "message.part.updated"
      sessionId: string
      messageId: string
      partId: string
      partType: string
      text: string | null
      toolName: string | null
      toolStatus: string | null
      toolInput: Record<string, unknown>
      toolOutput: unknown
      isError: boolean
    }
  | {
      type: "message.part.delta"
      sessionId: string
      messageId: string
      partId: string
      field: string
      delta: string
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

function opencodeSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "opencode",
    model,
    tools: ["OpenCode Server"],
    agents: [],
    slashCommands: [],
    mcpServers: [],
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function modelPayload(model: string | undefined) {
  if (!model || model === DEFAULT_OPENCODE_MODEL) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

function displayToolName(toolName: string): string {
  const normalized = toolName.toLowerCase().replace(/[_-]/g, "")
  switch (normalized) {
    case "bash":
      return "Bash"
    case "edit":
      return "Edit"
    case "grep":
      return "Grep"
    case "glob":
      return "Glob"
    case "read":
      return "Read"
    case "write":
      return "Write"
    case "todowrite":
      return "TodoWrite"
    case "websearch":
      return "WebSearch"
    case "webfetch":
      return "WebFetch"
    default:
      return toolName
  }
}

function toolCallEntry(event: Extract<OpenCodeEvent, { type: "message.part.updated" }>): TranscriptEntry {
  const toolName = displayToolName(event.toolName ?? "OpenCodeTool")
  return timestamped({
    kind: "tool_call",
    tool: normalizeToolCall({
      toolName,
      toolId: event.partId,
      input: event.toolInput,
    }),
  })
}

function toolResultEntry(event: Extract<OpenCodeEvent, { type: "message.part.updated" }>): TranscriptEntry {
  return timestamped({
    kind: "tool_result",
    toolId: event.partId,
    content: event.toolOutput ?? "",
    isError: event.isError,
  })
}

function parseOpenCodeEvent(raw: unknown): OpenCodeEvent | null {
  const envelope = asRecord(raw)
  const payload = asRecord(envelope?.payload ?? raw)
  const type = asString(payload?.type)
  const props = asRecord(payload?.properties) ?? {}

  switch (type) {
    case "server.connected":
      return { type: "server.connected" }
    case "session.status": {
      const status = asRecord(props.status)
      return {
        type: "session.status",
        sessionId: asString(props.sessionID) ?? "",
        status: asString(status?.type) ?? "",
      }
    }
    case "session.idle":
      return {
        type: "session.idle",
        sessionId: asString(props.sessionID) ?? "",
      }
    case "session.error": {
      const error = asRecord(props.error)
      const data = asRecord(error?.data)
      return {
        type: "session.error",
        sessionId: asString(props.sessionID) ?? "",
        message: asString(data?.message) ?? asString(error?.message) ?? "Unknown OpenCode error",
      }
    }
    case "message.updated": {
      const info = asRecord(props.info)
      const time = asRecord(info?.time)
      return {
        type: "message.updated",
        sessionId: asString(props.sessionID) ?? "",
        messageId: asString(info?.id) ?? "",
        role: asString(info?.role) ?? "",
        timeEnd: asNumber(time?.completed) ?? asNumber(time?.end),
        modelId: asString(info?.modelID),
        providerId: asString(info?.providerID),
      }
    }
    case "message.part.delta":
      return {
        type: "message.part.delta",
        sessionId: asString(props.sessionID) ?? "",
        messageId: asString(props.messageID) ?? "",
        partId: asString(props.partID) ?? "",
        field: asString(props.field) ?? "",
        delta: asString(props.delta) ?? "",
      }
    case "message.part.updated": {
      const part = asRecord(props.part)
      const state = asRecord(part?.state)
      return {
        type: "message.part.updated",
        sessionId: asString(props.sessionID) ?? "",
        messageId: asString(part?.messageID) ?? "",
        partId: asString(part?.id) ?? "",
        partType: asString(part?.type) ?? "",
        text: asString(part?.text),
        toolName: asString(part?.tool),
        toolStatus: asString(state?.status),
        toolInput: asRecord(state?.input) ?? {},
        toolOutput: state?.output,
        isError: Boolean(state?.error),
      }
    }
    default:
      return null
  }
}

export class OpenCodeServerManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly fetchImpl: FetchImpl
  private readonly spawnProcess: SpawnOpenCodeServer
  private readonly configuredBaseUrl: string | null
  private server: ServerState | null = null
  private stderrLines: string[] = []

  constructor(args: {
    baseUrl?: string
    fetch?: FetchImpl
    spawnProcess?: SpawnOpenCodeServer
  } = {}) {
    this.configuredBaseUrl = args.baseUrl?.replace(/\/$/, "") ?? null
    this.fetchImpl = args.fetch ?? fetch
    this.spawnProcess = args.spawnProcess ?? ((cwd) =>
      spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }) as unknown as OpenCodeServerProcess)
  }

  async startSession(args: StartOpenCodeSessionArgs): Promise<string | undefined> {
    if (args.pendingForkSessionToken) {
      throw new Error("OpenCode server sessions cannot be forked yet")
    }

    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && !args.pendingForkSessionToken) {
      return existing.sessionToken
    }
    if (existing) {
      this.stopSession(args.chatId)
    }

    const server = await this.ensureServer(args.cwd)
    const sessionToken = args.sessionToken && !args.pendingForkSessionToken
      ? args.sessionToken
      : await this.createSession(server, args.cwd)

    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      sessionToken,
      pendingTurn: null,
      closed: false,
    }
    this.sessions.set(args.chatId, context)
    return sessionToken
  }

  async startTurn(args: StartOpenCodeTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error("OpenCode turn is already running")
    }
    const server = await this.ensureServer(context.cwd)
    const queue = new AsyncQueue<HarnessEvent>()
    queue.push({ type: "session_token", sessionToken: context.sessionToken })
    queue.push({ type: "transcript", entry: opencodeSystemInitEntry(args.model ?? DEFAULT_OPENCODE_MODEL) })

    const pendingTurn: PendingTurn = {
      queue,
      resolved: false,
      textByMessageId: new Map(),
      roleByMessageId: new Map(),
      completedMessages: new Set(),
      startedToolIds: new Set(),
      hasThinkingStatus: false,
    }
    context.pendingTurn = pendingTurn

    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: args.content }],
    }
    const model = modelPayload(args.model)
    if (model) body.model = model

    const response = await this.fetchImpl(`${server.baseUrl}/session/${encodeURIComponent(context.sessionToken)}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      context.pendingTurn = null
      queue.finish()
      throw new Error(`OpenCode prompt failed: ${response.status} ${await response.text()}`)
    }

    return {
      provider: "opencode" satisfies AgentProvider,
      stream: queue,
      interrupt: async () => {
        if (context.pendingTurn !== pendingTurn || pendingTurn.resolved) return
        await this.abortSession(context).catch(() => undefined)
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
      },
      close: () => {},
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    if (context.pendingTurn && !context.pendingTurn.resolved) {
      void this.abortSession(context).catch(() => undefined)
    }
    context.closed = true
    context.pendingTurn?.queue.finish()
    context.pendingTurn = null
    this.sessions.delete(chatId)
  }

  stopAll() {
    for (const chatId of [...this.sessions.keys()]) {
      this.stopSession(chatId)
    }
    const server = this.server
    if (!server) return
    server.stopped = true
    server.abortController.abort()
    if (server.child) {
      try {
        server.child.kill("SIGKILL")
      } catch {
        // Ignore kill failures.
      }
    }
    this.server = null
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed) {
      throw new Error("OpenCode session not started")
    }
    return context
  }

  private async ensureServer(cwd: string): Promise<ServerState> {
    if (this.server && !this.server.stopped) return this.server

    if (this.configuredBaseUrl) {
      const server = this.createServerState(cwd, this.configuredBaseUrl, null)
      this.server = server
      this.startSseLoop(server)
      await server.ready
      return server
    }

    const child = this.spawnProcess(cwd)
    const baseUrl = await this.waitForServerUrl(child)
    const server = this.createServerState(cwd, baseUrl, child)
    this.server = server
    child.on("error", (error) => this.failAll(error.message))
    child.on("close", (code) => {
      if (server.stopped) return
      const message = this.stderrLines.at(-1) || `OpenCode server exited with code ${code ?? 1}`
      this.failAll(message)
    })
    this.startSseLoop(server)
    await server.ready
    return server
  }

  private createServerState(cwd: string, baseUrl: string, child: OpenCodeServerProcess | null): ServerState {
    let resolveReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    return {
      cwd,
      baseUrl: baseUrl.replace(/\/$/, ""),
      child,
      abortController: new AbortController(),
      ready,
      resolveReady,
      stopped: false,
    }
  }

  private async waitForServerUrl(child: OpenCodeServerProcess): Promise<string> {
    const urlPattern = /opencode server listening on (https?:\/\/\S+)/
    return await new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error("Timed out waiting for OpenCode server to start"))
      }, 10_000)
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })

      const handleLine = (line: string) => {
        if (line.trim()) this.stderrLines.push(line.trim())
        if (settled) return
        const match = line.match(urlPattern)
        if (!match) return
        settled = true
        clearTimeout(timeout)
        resolve(match[1])
      }

      stdout.on("line", handleLine)
      stderr.on("line", handleLine)
      child.on("error", (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      })
      child.on("close", (code) => {
        stdout.close()
        stderr.close()
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(this.stderrLines.at(-1) || `OpenCode server exited with code ${code ?? 1}`))
      })
    })
  }

  private startSseLoop(server: ServerState) {
    void (async () => {
      let attempts = 0
      while (!server.stopped) {
        try {
          const response = await this.fetchImpl(`${server.baseUrl}/global/event`, {
            signal: server.abortController.signal,
            headers: { Accept: "text/event-stream" },
          })
          server.resolveReady()
          if (!response.ok || !response.body) {
            throw new Error(`OpenCode event stream failed: ${response.status}`)
          }
          attempts = 0
          await this.consumeSse(response.body, server.abortController.signal)
        } catch (error) {
          server.resolveReady()
          if (server.stopped || server.abortController.signal.aborted) return
          const delayMs = Math.min(5_000, 250 * 2 ** attempts)
          attempts += 1
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          if (error instanceof Error) {
            this.stderrLines.push(error.message)
          }
        }
      }
    })()
  }

  private async consumeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.handleSseEvent(rawEvent)
          boundary = buffer.indexOf("\n\n")
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private handleSseEvent(rawEvent: string) {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return
    const parsed = parseJson(data)
    const event = parseOpenCodeEvent(parsed)
    if (!event) {
      this.recordUnknownEvent(parsed)
      return
    }
    this.dispatch(event)
  }

  private recordUnknownEvent(parsed: unknown) {
    const payload = asRecord(asRecord(parsed)?.payload ?? parsed)
    const type = asString(payload?.type)
    if (!type) return
    const line = `Ignored OpenCode server event: ${type}`
    if (!this.stderrLines.includes(line)) {
      this.stderrLines.push(line)
    }
  }

  private dispatch(event: OpenCodeEvent) {
    const sessionId = "sessionId" in event ? event.sessionId : null
    if (!sessionId) return
    for (const context of this.sessions.values()) {
      if (context.sessionToken === sessionId) {
        this.dispatchToSession(context, event)
      }
    }
  }

  private dispatchToSession(context: SessionContext, event: OpenCodeEvent) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return

    switch (event.type) {
      case "message.part.delta":
        if (event.field !== "text") {
          this.recordSkippedDeltaField(event.field)
          return
        }
        if (!event.delta) return
        pendingTurn.textByMessageId.set(
          event.messageId,
          `${pendingTurn.textByMessageId.get(event.messageId) ?? ""}${event.delta}`
        )
        return
      case "message.part.updated":
        this.handlePartUpdated(pendingTurn, event)
        return
      case "message.updated":
        if (event.messageId) {
          pendingTurn.roleByMessageId.set(event.messageId, event.role)
        }
        if (event.role === "assistant" && event.timeEnd !== null) {
          this.completeTurn(context, false, "", [event.messageId])
        }
        return
      case "session.idle":
        this.completeTurn(context, false, "")
        return
      case "session.error":
        this.completeTurn(context, true, event.message)
        return
      default:
        return
    }
  }

  private recordSkippedDeltaField(field: string) {
    if (!field) return
    const line = `Ignored OpenCode message.part.delta field: ${field}`
    if (!this.stderrLines.includes(line)) {
      this.stderrLines.push(line)
    }
  }

  private handlePartUpdated(pendingTurn: PendingTurn, event: Extract<OpenCodeEvent, { type: "message.part.updated" }>) {
    if (event.partType === "reasoning") {
      if (!pendingTurn.hasThinkingStatus) {
        pendingTurn.hasThinkingStatus = true
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({ kind: "status", status: "thinking" }),
        })
      }
      return
    }

    if (event.partType === "text" && event.text?.trim() && !pendingTurn.textByMessageId.get(event.messageId)?.trim()) {
      pendingTurn.textByMessageId.set(event.messageId, event.text)
      return
    }

    if (event.partType !== "tool" || !event.toolName || !event.partId) return
    if (!pendingTurn.startedToolIds.has(event.partId)) {
      pendingTurn.startedToolIds.add(event.partId)
      pendingTurn.queue.push({ type: "transcript", entry: toolCallEntry(event) })
    }
    if (event.toolStatus === "completed" || event.toolStatus === "failed") {
      pendingTurn.queue.push({ type: "transcript", entry: toolResultEntry(event) })
    }
  }

  private completeTurn(context: SessionContext, isError: boolean, message: string, completedMessageIds?: string[]) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return
    pendingTurn.resolved = true

    const assistantMessageIds = completedMessageIds
      ?? [...pendingTurn.textByMessageId.keys()].filter((messageId) => (
        pendingTurn.roleByMessageId.get(messageId) === "assistant"
      ))

    for (const messageId of assistantMessageIds) {
      const text = pendingTurn.textByMessageId.get(messageId)
      const trimmed = text?.trim()
      if (!trimmed || pendingTurn.completedMessages.has(messageId)) continue
      pendingTurn.completedMessages.add(messageId)
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "assistant_text",
          text: trimmed,
        }),
      })
    }

    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: isError ? "error" : "success",
        isError,
        durationMs: 0,
        result: message,
      }),
    })
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  private async createSession(server: ServerState, cwd: string): Promise<string> {
    const response = await this.fetchImpl(`${server.baseUrl}/session?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Kanna" }),
    })
    if (!response.ok) {
      throw new Error(`OpenCode session create failed: ${response.status} ${await response.text()}`)
    }
    const payload = asRecord(await response.json())
    const sessionId = asString(payload?.id)
    if (!sessionId) {
      throw new Error("OpenCode session create response missing id")
    }
    return sessionId
  }

  private async abortSession(context: SessionContext) {
    const server = await this.ensureServer(context.cwd)
    await this.fetchImpl(`${server.baseUrl}/session/${encodeURIComponent(context.sessionToken)}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  }

  private failAll(message: string) {
    for (const context of this.sessions.values()) {
      this.completeTurn(context, true, message)
    }
  }
}
