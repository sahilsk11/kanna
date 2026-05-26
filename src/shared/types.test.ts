import { describe, expect, test } from "bun:test"
import {
  DEFAULT_HERMES_MODEL,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  normalizeHermesModelId,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("shared model normalization", () => {
  test("normalizes Claude aliases via the provider catalog", () => {
    expect(normalizeClaudeModelId("opus")).toBe("claude-opus-4-7")
    expect(normalizeClaudeModelId("sonnet")).toBe("claude-sonnet-4-6")
    expect(normalizeClaudeModelId("haiku")).toBe("claude-haiku-4-5-20251001")
  })

  test("normalizes legacy Codex aliases and defaults to the latest catalog model", () => {
    expect(normalizeCodexModelId()).toBe("gpt-5.5")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5.3-codex")
  })

  test("normalizes Hermes to its configured default placeholder", () => {
    expect(normalizeHermesModelId()).toBe(DEFAULT_HERMES_MODEL)
    expect(normalizeHermesModelId("default")).toBe(DEFAULT_HERMES_MODEL)
    expect(normalizeHermesModelId("gpt-5.5")).toBe(DEFAULT_HERMES_MODEL)
  })

  test("uses declarative metadata for Claude max-effort support", () => {
    expect(supportsClaudeMaxReasoningEffort("claude-opus-4-7")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("claude-sonnet-4-6")).toBe(false)
  })
})
