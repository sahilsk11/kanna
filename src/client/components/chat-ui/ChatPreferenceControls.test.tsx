import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

describe("ChatPreferenceControls", () => {
  test("renders codex-specific controls and can omit plan mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.3-codex"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includePlanMode={false}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.3 Codex")
    expect(html).toContain("XHigh")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("renders claude plan mode controls when enabled", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="claude-opus-4-8"
        modelOptions={{ reasoningEffort: "max", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        planMode
        onPlanModeChange={() => {}}
        includePlanMode
      />
    )

    expect(html).toContain("Claude")
    expect(html).toContain("Opus")
    expect(html).toContain("Max")
    expect(html).toContain("1M")
    expect(html).toContain("Plan Mode")
  })

  test("renders Hermes without provider-specific option controls", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="hermes"
        model="hermes-configured-default"
        modelOptions={{}}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        planMode
        onPlanModeChange={() => {}}
        includePlanMode
      />
    )

    expect(html).toContain("Hermes")
    expect(html).toContain("Configured Default")
    expect(html).not.toContain("Fast Mode")
    expect(html).not.toContain("Plan Mode")
    expect(html).not.toContain("Full Access")
    expect(html).not.toContain("Max")
    expect(html).not.toContain("1M")
  })

  test("renders Fable as a Claude model option", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="fable"
        modelOptions={{ reasoningEffort: "high", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
        includePlanMode={false}
      />
    )

    expect(html).toContain("Fable")
    expect(html).toContain("High")
  })
})
