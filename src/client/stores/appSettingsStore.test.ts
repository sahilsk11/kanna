import { describe, expect, test } from "bun:test"
import type { AppSettingsSnapshot } from "../../shared/types"
import { mergeAppSettingsPatch } from "./appSettingsStore"

function settingsSnapshot(): AppSettingsSnapshot {
  return {
    analyticsEnabled: true,
    browserSettingsMigrated: false,
    theme: "system",
    sessionGrouping: "default",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    terminal: {
      scrollbackLines: 1_000,
      minColumnWidth: 450,
    },
    editor: {
      preset: "cursor",
      commandTemplate: "cursor {path}",
    },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: "claude-opus-4-7",
        modelOptions: { reasoningEffort: "high", contextWindow: "200k" },
        planMode: false,
      },
      codex: {
        model: "gpt-5.5",
        modelOptions: { reasoningEffort: "high", fastMode: false },
        planMode: false,
      },
      hermes: {
        model: "hermes-configured-default",
        modelOptions: {},
        planMode: false,
      },
      opencode: {
        model: "opencode-configured-default",
        modelOptions: {},
        planMode: false,
      },
    },
    warning: null,
    filePathDisplay: "~/.kanna/data/settings.json",
  }
}

describe("mergeAppSettingsPatch", () => {
  test("merges Hermes defaults without replacing Claude or Codex defaults", () => {
    const merged = mergeAppSettingsPatch(settingsSnapshot(), {
      defaultProvider: "hermes",
      providerDefaults: {
        hermes: {
          planMode: true,
        },
      },
    })

    expect(merged.defaultProvider).toBe("hermes")
    expect(merged.providerDefaults.hermes).toEqual({
      model: "hermes-configured-default",
      modelOptions: {},
      planMode: true,
    })
    expect(merged.providerDefaults.codex).toEqual(settingsSnapshot().providerDefaults.codex)
    expect(merged.providerDefaults.claude).toEqual(settingsSnapshot().providerDefaults.claude)
    expect(merged.providerDefaults.opencode).toEqual(settingsSnapshot().providerDefaults.opencode)
  })
})
