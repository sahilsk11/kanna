import { randomUUID } from "node:crypto"
import type { InteractionUpdate } from "@cursor/sdk"
import type { RunResult } from "@cursor/sdk"
import type { TranscriptEntry } from "../../shared/types"
import { normalizeToolCall } from "../../shared/tools"

export function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

export function cursorSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "cursor",
    model,
    tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "TodoWrite", "WebSearch", "WebFetch"],
    agents: [],
    slashCommands: [],
    mcpServers: [],
  })
}

export function isKnownCursorHttp2RejectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("NGHTTP2_FRAME_SIZE_ERROR")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function displayCursorToolName(toolType: string): string {
  const normalized = toolType.toLowerCase().replace(/[_-]/g, "")
  switch (normalized) {
    case "shell":
      return "Bash"
    case "read":
      return "Read"
    case "edit":
      return "Edit"
    case "write":
      return "Write"
    case "grep":
      return "Grep"
    case "glob":
      return "Glob"
    case "todowrite":
      return "TodoWrite"
    case "websearch":
      return "WebSearch"
    case "webfetch":
      return "WebFetch"
    case "delete":
      return "Delete"
    default:
      return toolType
  }
}

function toolInputFromStartedUpdate(update: Extract<InteractionUpdate, { type: "tool-call-started" }>) {
  const toolCall = update.toolCall as { type?: string; args?: unknown }
  const args = asRecord(toolCall.args) ?? {}
  if (toolCall.type === "shell" && typeof args.command === "string") {
    return { command: args.command }
  }
  if (toolCall.type === "read" && typeof args.path === "string") {
    return { file_path: args.path }
  }
  if ((toolCall.type === "edit" || toolCall.type === "write") && typeof args.path === "string") {
    return { file_path: args.path, ...args }
  }
  if (toolCall.type === "grep" && typeof args.pattern === "string") {
    return { pattern: args.pattern, ...args }
  }
  if (toolCall.type === "glob" && typeof args.pattern === "string") {
    return { pattern: args.pattern, ...args }
  }
  return args
}

function toolResultContent(update: Extract<InteractionUpdate, { type: "tool-call-completed" }>) {
  const toolCall = update.toolCall as { result?: unknown }
  const result = toolCall.result
  if (result === undefined) return ""
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function toolResultIsError(update: Extract<InteractionUpdate, { type: "tool-call-completed" }>) {
  const toolCall = update.toolCall as { result?: { status?: string } }
  const result = asRecord(toolCall.result)
  return result?.status === "error"
}

export interface CursorTurnStreamState {
  hasThinkingStatus: boolean
  startedToolIds: Set<string>
}

export function createCursorTurnStreamState(): CursorTurnStreamState {
  return {
    hasThinkingStatus: false,
    startedToolIds: new Set(),
  }
}

export function normalizeCursorDeltaUpdate(
  update: InteractionUpdate,
  state: CursorTurnStreamState,
): TranscriptEntry[] {
  switch (update.type) {
    case "text-delta":
      return update.text
        ? [timestamped({ kind: "assistant_text", text: update.text })]
        : []
    case "thinking-delta":
      if (!state.hasThinkingStatus) {
        state.hasThinkingStatus = true
        return [timestamped({ kind: "status", status: "thinking" })]
      }
      return []
    case "tool-call-started": {
      if (state.startedToolIds.has(update.callId)) return []
      state.startedToolIds.add(update.callId)
      const toolCall = update.toolCall as { type?: string }
      const toolType = typeof toolCall.type === "string" ? toolCall.type : "unknown"
      return [
        timestamped({
          kind: "tool_call",
          tool: normalizeToolCall({
            toolName: displayCursorToolName(toolType),
            toolId: update.callId,
            input: toolInputFromStartedUpdate(update),
          }),
        }),
      ]
    }
    case "tool-call-completed":
      return [
        timestamped({
          kind: "tool_result",
          toolId: update.callId,
          content: toolResultContent(update),
          isError: toolResultIsError(update),
        }),
      ]
    default:
      return []
  }
}

export function buildCursorResultEntry(result: RunResult): TranscriptEntry {
  const subtype = result.status === "finished"
    ? "success"
    : result.status === "cancelled"
      ? "cancelled"
      : "error"
  return timestamped({
    kind: "result",
    subtype,
    isError: result.status !== "finished",
    durationMs: result.durationMs ?? 0,
    result: result.result ?? "",
  })
}
