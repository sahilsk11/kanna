import { describe, expect, test } from "bun:test"
import {
  DEFAULT_HERMES_MODEL,
  DEFAULT_OPENCODE_MODEL,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  normalizeHermesModelId,
  normalizeHermesProfileId,
  normalizeOpenCodeModelId,
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

  test("normalizes Hermes model ids to configured defaults", () => {
    expect(normalizeHermesModelId()).toBe(DEFAULT_HERMES_MODEL)
    expect(normalizeHermesModelId("default")).toBe(DEFAULT_HERMES_MODEL)
    expect(normalizeHermesModelId("stormbreaker")).toBe(DEFAULT_HERMES_MODEL)
    expect(normalizeHermesModelId("custom-profile")).toBe(DEFAULT_HERMES_MODEL)
  })

  test("normalizes Hermes profiles while preserving custom profile ids", () => {
    expect(normalizeHermesProfileId()).toBe("default")
    expect(normalizeHermesProfileId("stormbreaker")).toBe("stormbreaker")
    expect(normalizeHermesProfileId("custom-profile")).toBe("custom-profile")
  })

  test("normalizes OpenCode defaults while preserving model ids from discovery", () => {
    expect(normalizeOpenCodeModelId()).toBe(DEFAULT_OPENCODE_MODEL)
    expect(normalizeOpenCodeModelId("default")).toBe(DEFAULT_OPENCODE_MODEL)
    expect(normalizeOpenCodeModelId("opencode/kimi-k2.5")).toBe("opencode/kimi-k2.5")
  })

  test("uses declarative metadata for Claude max-effort support", () => {
    expect(supportsClaudeMaxReasoningEffort("claude-opus-4-7")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("claude-sonnet-4-6")).toBe(false)
  })
})
