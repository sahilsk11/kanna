import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CursorManager } from "./cursor-manager"

class FakeCursorProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: any[] = []
  killed = false

  constructor(private readonly onMessage?: (message: any, process: FakeCursorProcess) => void) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.messages.push(message)
        this.onMessage?.(message, this)
      }
    })
  }

  kill() {
    this.killed = true
    this.emit("close", 0)
  }

  writeAgentMessage(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  writeStderr(message: string) {
    this.stderr.write(`${message}\n`)
  }

  closeWithCode(code: number) {
    this.emit("close", code)
  }
}

async function collectStream(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

function initializeAndNewSession(message: any, child: FakeCursorProcess, sessionId = "cursor-session-1") {
  if (message.method === "initialize") {
    child.writeAgentMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "cursor_login" }],
      },
    })
    return true
  }
  if (message.method === "session/new") {
    child.writeAgentMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId,
        modes: { currentModeId: "agent", availableModes: [] },
        models: { currentModelId: "composer-2.5[fast=true]", availableModels: [] },
      },
    })
    return true
  }
  return false
}

describe("CursorManager", () => {
  test("initializes Cursor ACP and starts a fresh session", async () => {
    const process = new FakeCursorProcess((message, child) => {
      initializeAndNewSession(message, child)
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })

    const sessionToken = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      sessionToken: null,
    })

    expect(sessionToken).toBe("cursor-session-1")
    expect(process.messages.map((message) => message.method)).toEqual(["initialize", "session/new"])
    expect(process.messages[0].params.clientCapabilities).toEqual({
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    })
  })

  test("loads a cached Cursor session token", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/load") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: {} })
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })

    const sessionToken = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      sessionToken: "cached-session",
    })

    expect(sessionToken).toBe("cached-session")
    expect(process.messages.map((message) => message.method)).toEqual(["initialize", "session/load"])
    expect(process.messages[1].params).toEqual({
      cwd: "/tmp/project",
      sessionId: "cached-session",
      mcpServers: [],
    })
  })

  test("streams assistant text, usage, and final result", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (initializeAndNewSession(message, child)) return
      if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "KANNA" },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          },
        })
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "Say KANNA" })
    const events = await collectStream(turn.stream)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(events[0]).toEqual({ type: "session_token", sessionToken: "cursor-session-1" })
    expect(transcriptKinds).toEqual(["system_init", "assistant_text", "context_window_updated", "result"])
    expect(events.find((event) => event.entry?.kind === "assistant_text")?.entry.text).toBe("KANNA")
    expect(process.messages.find((message) => message.method === "session/prompt").params.prompt).toEqual([
      { type: "text", text: "Say KANNA" },
    ])
  })

  test("sets Cursor mode but leaves model selection to Cursor defaults", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (initializeAndNewSession(message, child)) return
      if (message.method === "session/set_mode") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: {} })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "plan",
      model: "composer-2.5[fast=true]",
      planMode: true,
    })
    await collectStream(turn.stream)

    expect(process.messages.map((message) => message.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/prompt",
    ])
    expect(process.messages[2].params).toEqual({ sessionId: "cursor-session-1", modeId: "plan" })
  })

  test("allows full-access permission requests with JSON-RPC id zero and records tool result", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (initializeAndNewSession(message, child)) return
      if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "`pwd`",
              kind: "execute",
              status: "pending",
              rawInput: { command: "pwd" },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: "cursor-session-1",
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject-once", kind: "reject_once" },
            ],
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "cursor-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              status: "completed",
              rawOutput: "allowed",
            },
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "run pwd" })
    const events = await collectStream(turn.stream)
    const permissionResponse = process.messages.find((message) => message.id === 0)

    expect(permissionResponse).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    })
    expect(events.find((event) => event.entry?.kind === "tool_call")?.entry.tool.toolKind).toBe("bash")
    expect(events.find((event) => event.entry?.kind === "tool_result")?.entry.content).toBe("allowed")
  })

  test("rejects plan-mode permission requests", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (initializeAndNewSession(message, child)) return
      if (message.method === "session/set_mode") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: null })
        return
      }
      if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: "cursor-session-1",
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject-once", kind: "reject_once" },
            ],
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "plan only", planMode: true })
    await collectStream(turn.stream)
    const permissionResponse = process.messages.find((message) => message.id === 0)

    expect(permissionResponse).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    })
  })

  test("sends session/cancel notification on interrupt", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (initializeAndNewSession(message, child)) return
      if (message.method === "session/prompt") {
        // Keep the prompt open until interrupt.
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "long answer" })
    await turn.interrupt()

    expect(process.messages.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "cursor-session-1" },
    })
  })

  test("lists Cursor sessions", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/list") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessions: [{ sessionId: "cursor-session-1", cwd: "/tmp/project", title: "Cursor smoke" }],
          },
        })
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })

    const sessions = await manager.listSessions({ cwd: "/tmp/project" })

    expect(sessions).toEqual([{ sessionId: "cursor-session-1", cwd: "/tmp/project", title: "Cursor smoke" }])
    expect(process.killed).toBe(true)
  })

  test("fails pending turn when Cursor ACP exits", async () => {
    const process = new FakeCursorProcess((message, child) => {
      if (initializeAndNewSession(message, child)) return
      if (message.method === "session/prompt") {
        child.writeStderr("cursor crashed")
        child.closeWithCode(1)
      }
    })
    const manager = new CursorManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "fail" })
    const events = await collectStream(turn.stream)
    const result = events.find((event) => event.entry?.kind === "result")?.entry

    expect(result?.isError).toBe(true)
    expect(result?.result).toContain("cursor crashed")
  })
})
