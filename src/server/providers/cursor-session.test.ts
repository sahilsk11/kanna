import { describe, expect, test } from "bun:test"
import type { InteractionUpdate, RunResult } from "@cursor/sdk"
import {
  buildCursorResultEntry,
  createCursorTurnStreamState,
  displayCursorToolName,
  isKnownCursorHttp2RejectionError,
  normalizeCursorDeltaUpdate,
} from "./cursor-session"

describe("cursor session helpers", () => {
  test("maps cursor tool types to harness tool names", () => {
    expect(displayCursorToolName("shell")).toBe("Bash")
    expect(displayCursorToolName("read")).toBe("Read")
    expect(displayCursorToolName("custom-tool")).toBe("custom-tool")
  })

  test("normalizes text deltas into assistant transcript entries", () => {
    const state = createCursorTurnStreamState()
    const entries = normalizeCursorDeltaUpdate(
      { type: "text-delta", text: "Hello" } as InteractionUpdate,
      state,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("assistant_text")
    expect(entries[0]).toMatchObject({ text: "Hello" })
  })

  test("emits a single thinking status for thinking deltas", () => {
    const state = createCursorTurnStreamState()
    const first = normalizeCursorDeltaUpdate(
      { type: "thinking-delta", text: "..." } as InteractionUpdate,
      state,
    )
    const second = normalizeCursorDeltaUpdate(
      { type: "thinking-delta", text: "more" } as InteractionUpdate,
      state,
    )

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: "status", status: "thinking" })
    expect(second).toHaveLength(0)
  })

  test("maps tool lifecycle updates into tool_call and tool_result entries", () => {
    const state = createCursorTurnStreamState()
    const started = normalizeCursorDeltaUpdate(
      {
        type: "tool-call-started",
        callId: "call-1",
        toolCall: { type: "shell", args: { command: "ls" } },
      } as unknown as InteractionUpdate,
      state,
    )
    const completed = normalizeCursorDeltaUpdate(
      {
        type: "tool-call-completed",
        callId: "call-1",
        toolCall: { result: { status: "success", output: "ok" } },
      } as unknown as InteractionUpdate,
      state,
    )

    expect(started).toHaveLength(1)
    expect(started[0]?.kind).toBe("tool_call")
    expect(started[0]).toMatchObject({
      tool: {
        toolName: "Bash",
        toolId: "call-1",
        input: { command: "ls" },
      },
    })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.kind).toBe("tool_result")
    expect(completed[0]).toMatchObject({
      toolId: "call-1",
      isError: false,
    })
  })

  test("builds terminal result entries from run results", () => {
    expect(buildCursorResultEntry({
      status: "finished",
      durationMs: 1200,
      result: "done",
    })).toMatchObject({
      kind: "result",
      subtype: "success",
      isError: false,
      durationMs: 1200,
      result: "done",
    })

    expect(buildCursorResultEntry({
      status: "cancelled",
      durationMs: 300,
      result: "",
    })).toMatchObject({
      subtype: "cancelled",
      isError: true,
    })
  })

  test("detects the known Bun HTTP/2 stream rejection", () => {
    expect(isKnownCursorHttp2RejectionError(new Error("NGHTTP2_FRAME_SIZE_ERROR"))).toBe(true)
    expect(isKnownCursorHttp2RejectionError(new Error("other"))).toBe(false)
  })
})
