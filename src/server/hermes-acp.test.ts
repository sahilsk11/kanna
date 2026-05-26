import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { HermesAcpManager } from "./hermes-acp"

class FakeHermesProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: unknown[] = []
  killed = false

  constructor(
    private readonly onMessage?: (message: any, process: FakeHermesProcess) => void
  ) {
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

describe("HermesAcpManager", () => {
  test("initializes Hermes ACP and starts a fresh session", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: { sessionId: "hermes-session-1" },
        })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })

    const sessionToken = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      sessionToken: null,
    })

    expect(sessionToken).toBe("hermes-session-1")
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "session/new",
    ])
    expect((process.messages[0] as any).params.clientCapabilities).toEqual({
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    })
  })

  test("reinitializes existing context when no Hermes session token was cached", async () => {
    const processes: FakeHermesProcess[] = []
    const manager = new HermesAcpManager({
      spawnProcess: () => {
        const process = new FakeHermesProcess((message, child) => {
          if (message.method === "initialize") {
            child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
          } else if (message.method === "session/resume") {
            child.writeAgentMessage({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "missing session" },
            })
          } else if (message.method === "session/new") {
            child.writeAgentMessage({
              jsonrpc: "2.0",
              id: message.id,
              result: { sessionId: "hermes-session-recovered" },
            })
          }
        })
        processes.push(process)
        return process as never
      },
    })

    await expect(manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      sessionToken: "stale-hermes-session",
    })).rejects.toThrow("missing session")

    const recoveredToken = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      sessionToken: null,
    })

    expect(recoveredToken).toBe("hermes-session-recovered")
    expect(processes).toHaveLength(2)
    expect(processes[0].killed).toBe(true)
    expect(processes[1].messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "session/new",
    ])
  })

  test("streams assistant text and final result from session updates", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello from Hermes" },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
          },
        })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "Say hello",
      model: "hermes-configured-default",
    })
    const events = await collectStream(turn.stream)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(events[0]).toEqual({ type: "session_token", sessionToken: "hermes-session-1" })
    expect(transcriptKinds).toEqual(["system_init", "assistant_text", "context_window_updated", "result"])
    const assistant = events.find((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
    expect(assistant?.entry.text).toBe("Hello from Hermes")
    const prompt = process.messages.find((message: any) => message.method === "session/prompt") as any
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "Say hello" }])
  })

  test("marks Hermes thought chunks hidden so they do not render as final text", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "We need to decide how to answer." },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello from Hermes" },
            },
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "hello Hermes" })
    const events = await collectStream(turn.stream)
    const assistantMessages = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
      .map((event) => event.entry)

    expect(assistantMessages).toEqual([
      expect.objectContaining({
        kind: "assistant_text",
        text: "We need to decide how to answer.",
        hidden: true,
      }),
      expect.objectContaining({
        kind: "assistant_text",
        text: "Hello from Hermes",
      }),
    ])
    expect(assistantMessages[1].hidden).toBeUndefined()
  })

  test("marks raw Hermes tool-call markup hidden when it arrives as assistant text", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "<tool_call>\n<function=execute_code>\n</function>\n</tool_call>",
              },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done." },
            },
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "use a tool" })
    const events = await collectStream(turn.stream)
    const assistantMessages = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
      .map((event) => event.entry)

    expect(assistantMessages).toEqual([
      expect.objectContaining({
        kind: "assistant_text",
        text: "<tool_call>\n<function=execute_code>\n</function>\n</tool_call>",
        hidden: true,
      }),
      expect.objectContaining({
        kind: "assistant_text",
        text: "Done.",
      }),
    ])
    expect(assistantMessages[1].hidden).toBeUndefined()
  })

  test("marks Hermes scratchpad text hidden when it arrives as assistant text", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "We need to respond to the user greeting \"hello Hermes\". No specific tool needed. Let's respond.\n\n",
              },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello!" },
            },
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "hello Hermes" })
    const events = await collectStream(turn.stream)
    const assistantMessages = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
      .map((event) => event.entry)

    expect(assistantMessages[0]).toMatchObject({
      kind: "assistant_text",
      hidden: true,
    })
    expect(assistantMessages[1]).toMatchObject({
      kind: "assistant_text",
      text: "Hello!",
    })
    expect(assistantMessages[1].hidden).toBeUndefined()
  })

  test("marks exact-response preface text hidden when it arrives as assistant text", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello from Hermes is the exact response requested.\n" },
            },
          },
        })
        child.writeAgentMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "hermes-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello from Hermes" },
            },
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "Reply with exactly: hello from Hermes" })
    const events = await collectStream(turn.stream)
    const assistantMessages = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
      .map((event) => event.entry)

    expect(assistantMessages[0]).toMatchObject({
      kind: "assistant_text",
      hidden: true,
    })
    expect(assistantMessages[1]).toMatchObject({
      kind: "assistant_text",
      text: "hello from Hermes",
    })
    expect(assistantMessages[1].hidden).toBeUndefined()
  })

  test("sends session cancel notification when interrupted", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "keep working" })
    await turn.interrupt()

    const cancel = process.messages.find((message: any) => message.method === "session/cancel") as any
    expect(cancel).toBeDefined()
    expect(cancel.id).toBeUndefined()
    expect(cancel.params).toEqual({ sessionId: "hermes-session-1" })
  })

  test("reports stderr when Hermes ACP closes during an active turn", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeStderr("Hermes provider failed")
        child.closeWithCode(1)
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "fail" })
    const events = await collectStream(turn.stream)
    const result = events.find((event) => event.type === "transcript" && event.entry.kind === "result")

    expect(result?.entry).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
      result: "Hermes provider failed",
    })
  })

  test("denies permission requests so Hermes ACP does not hang", async () => {
    const process = new FakeHermesProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
      } else if (message.method === "session/new") {
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-1" } })
      } else if (message.method === "session/prompt") {
        child.writeAgentMessage({
          jsonrpc: "2.0",
          id: "perm-1",
          method: "session/request_permission",
          params: {
            sessionId: "hermes-session-1",
            toolCall: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              title: "terminal: rm -rf /tmp/example",
              kind: "execute",
              status: "pending",
            },
            options: [
              { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
              { optionId: "deny", kind: "reject_once", name: "Deny" },
            ],
          },
        })
        child.writeAgentMessage({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
    })
    const manager = new HermesAcpManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "run dangerous command" })
    await collectStream(turn.stream)

    const permissionResponse = process.messages.find((message: any) => message.id === "perm-1") as any
    expect(permissionResponse).toEqual({
      jsonrpc: "2.0",
      id: "perm-1",
      result: {
        outcome: {
          outcome: "selected",
          optionId: "deny",
        },
      },
    })
  })
})
