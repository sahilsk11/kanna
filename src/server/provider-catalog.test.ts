import { describe, expect, test } from "bun:test"
import {
  codexServiceTierFromModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeHermesModelOptions,
  normalizeServerModel,
  parseCursorModelsOutput,
  parseOpenCodeModelsOutput,
  refreshServerProviderCatalog,
} from "./provider-catalog"
import { DEFAULT_HERMES_MODEL, resolveClaudeApiModelId } from "../shared/types"

describe("provider catalog normalization", () => {
  test("maps legacy Claude effort into shared model options", () => {
    expect(normalizeClaudeModelOptions("claude-opus-4-7", undefined, "max")).toEqual({
      reasoningEffort: "max",
      contextWindow: "200k",
    })
  })

  test("normalizes Claude context window only for supported models", () => {
    expect(normalizeClaudeModelOptions("claude-sonnet-4-6", {
      claude: {
        reasoningEffort: "medium",
        contextWindow: "1m",
      },
    })).toEqual({
      reasoningEffort: "medium",
      contextWindow: "1m",
    })

    expect(normalizeClaudeModelOptions("claude-haiku-4-5-20251001", {
      claude: {
        reasoningEffort: "medium",
        contextWindow: "1m",
      },
    })).toMatchObject({
      reasoningEffort: "medium",
    })
  })

  test("normalizes Codex model options and fast mode defaults", () => {
    expect(normalizeCodexModelOptions(undefined)).toEqual({
      reasoningEffort: "high",
      fastMode: false,
    })

    const normalized = normalizeCodexModelOptions({
      codex: {
        reasoningEffort: "xhigh",
        fastMode: true,
      },
    })

    expect(normalized).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    })
    expect(codexServiceTierFromModelOptions(normalized)).toBe("fast")
  })

  test("normalizes server model ids through the shared alias catalog", () => {
    expect(normalizeServerModel("codex")).toBe("gpt-5.5")
    expect(normalizeServerModel("claude", "opus")).toBe("claude-opus-4-7")
    expect(normalizeServerModel("codex", "gpt-5-codex")).toBe("gpt-5.3-codex")
    expect(normalizeServerModel("hermes", "gpt-5.5")).toBe(DEFAULT_HERMES_MODEL)
    expect(normalizeServerModel("cursor", "not-in-catalog")).toBe("auto")
  })

  test("normalizes Hermes to empty configured-default model options", () => {
    expect(normalizeHermesModelOptions()).toEqual({})
  })

  test("normalizes Cursor to empty configured-default model options", () => {
    expect(normalizeCursorModelOptions()).toEqual({})
  })

  test("parses OpenCode model ids from CLI output", () => {
    expect(parseOpenCodeModelsOutput(`
opencode/big-pickle
opencode-go/kimi-k2.5
opencode-go/kimi-k2.5
not-a-model
    `)).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle", supportsEffort: false },
      { id: "opencode-go/kimi-k2.5", label: "opencode-go/kimi-k2.5", supportsEffort: false },
    ])
  })

  test("can filter OpenCode model ids to OpenCode Go", () => {
    expect(parseOpenCodeModelsOutput(`
opencode/big-pickle
opencode-go/deepseek-v4-pro
openrouter/deepseek/deepseek-v4-pro
    `, ["opencode-go"])).toEqual([
      { id: "opencode-go/deepseek-v4-pro", label: "opencode-go/deepseek-v4-pro", supportsEffort: false },
    ])
  })

  test("parses Cursor models from agent models output", () => {
    expect(parseCursorModelsOutput(`
Available models

auto - Auto
composer-2.5 - Composer 2.5 (current)
composer-2.5-fast - Composer 2.5 Fast (default)
Tip: use --model <id> (or /model <id> in interactive mode) to switch.
    `)).toEqual([
      { id: "auto", label: "Auto", supportsEffort: false },
      { id: "composer-2.5", label: "Composer 2.5 (current)", supportsEffort: false },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast (default)", supportsEffort: false },
    ])
  })

  test("refreshes Cursor catalog from discovered models and falls back to Composer 2.5", async () => {
    let providers = await refreshServerProviderCatalog({
      discoverOpenCodeModels: async () => [],
      discoverCursorModels: async () => [
        { id: "auto", label: "Auto", supportsEffort: false },
        { id: "composer-2.5", label: "Composer 2.5 (current)", supportsEffort: false },
        { id: "composer-2.5-fast", label: "Composer 2.5 Fast (default)", supportsEffort: false },
      ],
    })
    let cursor = providers.find((provider) => provider.id === "cursor")
    expect(cursor?.defaultModel).toBe("composer-2.5-fast")
    expect(cursor?.models.map((model) => model.id)).toEqual(["auto", "composer-2.5", "composer-2.5-fast"])
    expect(normalizeServerModel("cursor", "composer-2.5")).toBe("composer-2.5")

    providers = await refreshServerProviderCatalog({
      discoverOpenCodeModels: async () => [],
      discoverCursorModels: async () => {
        throw new Error("agent missing")
      },
    })
    cursor = providers.find((provider) => provider.id === "cursor")
    expect(cursor?.defaultModel).toBe("auto")
    expect(cursor?.models.map((model) => model.id)).toEqual(["auto", "composer-2.5-fast", "composer-2.5"])
  })

  test("resolves Claude API model ids for 1m context window", () => {
    expect(resolveClaudeApiModelId("claude-opus-4-7", "1m")).toBe("claude-opus-4-7[1m]")
    expect(resolveClaudeApiModelId("claude-sonnet-4-6", "200k")).toBe("claude-sonnet-4-6")
  })
})
