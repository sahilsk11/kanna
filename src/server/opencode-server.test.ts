import { describe, expect, test } from "bun:test"
import { OpenCodeServerManager } from "./opencode-server"

function ssePayload(payload: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify({ payload })}\n\n`)
}

function createSseHarness() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
    },
  })
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    send(payload: unknown) {
      controller?.enqueue(ssePayload(payload))
    },
    close() {
      controller?.close()
    },
  }
}

async function collectStream(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

describe("OpenCodeServerManager", () => {
  test("creates an OpenCode server session and renders completed assistant text", async () => {
    const sse = createSseHarness()
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const manager = new OpenCodeServerManager({
      baseUrl: "http://127.0.0.1:1234",
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith("/global/event")) return sse.response
        if (String(url).includes("/session?")) return Response.json({ id: "session-1" })
        if (String(url).endsWith("/session/session-1/prompt_async")) return Response.json({})
        return new Response("not found", { status: 404 })
      }) as typeof fetch,
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "hello",
      model: "opencode-go/kimi-k2.6",
    })
    const eventsPromise = collectStream(turn.stream)

    sse.send({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "Hello ",
      },
    })
    sse.send({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "from OpenCode",
      },
    })
    sse.send({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "message-1",
          role: "assistant",
          time: { completed: Date.now() },
        },
      },
    })

    const events = await eventsPromise
    const init = events.find((event) => event.type === "transcript" && event.entry.kind === "system_init")
    const assistant = events.find((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
    const result = events.find((event) => event.type === "transcript" && event.entry.kind === "result")
    const promptRequest = requests.find((request) => request.url.endsWith("/session/session-1/prompt_async"))
    const promptBody = JSON.parse(String(promptRequest?.init?.body))

    expect(turn.provider).toBe("opencode")
    expect(init?.entry).toMatchObject({
      kind: "system_init",
      provider: "opencode",
      model: "opencode-go/kimi-k2.6",
      tools: ["OpenCode Server"],
    })
    expect(promptBody.model).toEqual({
      providerID: "opencode-go",
      modelID: "kimi-k2.6",
    })
    expect(assistant?.entry).toMatchObject({
      kind: "assistant_text",
      text: "Hello from OpenCode",
    })
    expect(result?.entry).toMatchObject({
      kind: "result",
      subtype: "success",
      isError: false,
    })

    manager.stopAll()
  })

  test("flushes known assistant text when the session goes idle before message completion", async () => {
    const sse = createSseHarness()
    const manager = new OpenCodeServerManager({
      baseUrl: "http://127.0.0.1:1234",
      fetch: (async (url) => {
        if (String(url).endsWith("/global/event")) return sse.response
        if (String(url).includes("/session?")) return Response.json({ id: "session-1" })
        if (String(url).endsWith("/session/session-1/prompt_async")) return Response.json({})
        return new Response("not found", { status: 404 })
      }) as typeof fetch,
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })
    const turn = await manager.startTurn({ chatId: "chat-1", content: "hello" })
    const eventsPromise = collectStream(turn.stream)

    sse.send({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "message-1",
          role: "assistant",
          time: {},
        },
      },
    })
    sse.send({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "final text without message.updated",
      },
    })
    sse.send({
      type: "session.idle",
      properties: {
        sessionID: "session-1",
      },
    })

    const events = await eventsPromise
    const assistant = events.find((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
    expect(assistant?.entry).toMatchObject({
      kind: "assistant_text",
      text: "final text without message.updated",
    })

    manager.stopAll()
  })

  test("does not render user message deltas as assistant text", async () => {
    const sse = createSseHarness()
    const manager = new OpenCodeServerManager({
      baseUrl: "http://127.0.0.1:1234",
      fetch: (async (url) => {
        if (String(url).endsWith("/global/event")) return sse.response
        if (String(url).includes("/session?")) return Response.json({ id: "session-1" })
        if (String(url).endsWith("/session/session-1/prompt_async")) return Response.json({})
        return new Response("not found", { status: 404 })
      }) as typeof fetch,
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })
    const turn = await manager.startTurn({ chatId: "chat-1", content: "Reply with exactly: first opencode check" })
    const eventsPromise = collectStream(turn.stream)

    sse.send({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "user-message",
        partID: "user-part",
        field: "text",
        delta: "Reply with exactly: first opencode check",
      },
    })
    sse.send({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "user-message",
          role: "user",
          time: { completed: Date.now() },
        },
      },
    })
    sse.send({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-message",
        partID: "assistant-part",
        field: "text",
        delta: "first opencode check",
      },
    })
    sse.send({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "assistant-message",
          role: "assistant",
          time: { completed: Date.now() },
        },
      },
    })

    const events = await eventsPromise
    const assistantEntries = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
      .map((event) => event.entry.text)

    expect(assistantEntries).toEqual(["first opencode check"])

    manager.stopAll()
  })

  test("maps reasoning and tool part updates without persisting raw thoughts", async () => {
    const sse = createSseHarness()
    const manager = new OpenCodeServerManager({
      baseUrl: "http://127.0.0.1:1234",
      fetch: (async (url) => {
        if (String(url).endsWith("/global/event")) return sse.response
        if (String(url).includes("/session?")) return Response.json({ id: "session-1" })
        if (String(url).endsWith("/session/session-1/prompt_async")) return Response.json({})
        return new Response("not found", { status: 404 })
      }) as typeof fetch,
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", sessionToken: null })
    const turn = await manager.startTurn({ chatId: "chat-1", content: "run ls" })
    const eventsPromise = collectStream(turn.stream)

    sse.send({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          id: "reason-1",
          messageID: "message-1",
          type: "reasoning",
          text: "private chain of thought",
        },
      },
    })
    sse.send({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          id: "tool-1",
          messageID: "message-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "ls" },
          },
        },
      },
    })
    sse.send({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          id: "tool-1",
          messageID: "message-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "README.md",
          },
        },
      },
    })
    sse.send({
      type: "session.idle",
      properties: {
        sessionID: "session-1",
      },
    })

    const events = await eventsPromise
    const entries = events.filter((event) => event.type === "transcript").map((event) => event.entry)

    expect(entries.filter((entry) => entry.kind === "status")).toEqual([
      expect.objectContaining({ kind: "status", status: "thinking" }),
    ])
    expect(entries.filter((entry) => entry.kind === "assistant_text")).toHaveLength(0)
    expect(entries.find((entry) => entry.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: {
        toolKind: "bash",
        input: { command: "ls" },
      },
    })
    expect(entries.find((entry) => entry.kind === "tool_result")).toMatchObject({
      kind: "tool_result",
      toolId: "tool-1",
      content: "README.md",
    })

    manager.stopAll()
  })
})
