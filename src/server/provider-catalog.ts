import { spawn } from "node:child_process"
import type {
  AgentProvider,
  ClaudeModelOptions,
  CodexModelOptions,
  ClaudeContextWindow,
  HermesModelOptions,
  ModelOptions,
  OpenCodeModelOptions,
  ProviderCatalogEntry,
  ProviderModelOption,
  ServiceTier,
} from "../shared/types"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_HERMES_MODEL_OPTIONS,
  DEFAULT_OPENCODE_MODEL_OPTIONS,
  PROVIDERS,
  normalizeClaudeContextWindow,
  normalizeOpenCodeModelId,
  normalizeProviderModelId,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
} from "../shared/types"

const HARD_CODED_CODEX_MODELS: ProviderModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: false },
  { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportsEffort: false },
]

function buildServerProviders(openCodeModels?: ProviderModelOption[]): ProviderCatalogEntry[] {
  return PROVIDERS.map((provider) => {
    if (provider.id === "codex") {
      return {
        ...provider,
        defaultModel: "gpt-5.5",
        models: HARD_CODED_CODEX_MODELS,
      }
    }
    if (provider.id === "opencode" && openCodeModels?.length) {
      return {
        ...provider,
        defaultModel: openCodeModels[0].id,
        models: openCodeModels,
      }
    }
    return provider
  })
}

export let SERVER_PROVIDERS: ProviderCatalogEntry[] = buildServerProviders()

export function parseOpenCodeModelsOutput(output: string): ProviderModelOption[] {
  const seen = new Set<string>()
  const models: ProviderModelOption[] = []

  for (const line of output.split(/\r?\n/)) {
    const modelId = line.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\s+/)[0]
    if (!modelId || !modelId.includes("/") || seen.has(modelId)) {
      continue
    }
    seen.add(modelId)
    models.push({
      id: modelId,
      label: modelId,
      supportsEffort: false,
    })
  }

  return models
}

export async function discoverOpenCodeModels(options?: {
  command?: string
  timeoutMs?: number
}): Promise<ProviderModelOption[]> {
  const command = options?.command ?? "opencode"
  const timeoutMs = options?.timeoutMs ?? 10_000

  return await new Promise((resolve, reject) => {
    const child = spawn(command, ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error(`Timed out while running ${command} models`))
    }, timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`${command} models exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
        return
      }
      resolve(parseOpenCodeModelsOutput(stdout))
    })
  })
}

export async function refreshServerProviderCatalog(options?: {
  discoverOpenCodeModels?: () => Promise<ProviderModelOption[]>
}): Promise<ProviderCatalogEntry[]> {
  try {
    const openCodeModels = await (options?.discoverOpenCodeModels ?? discoverOpenCodeModels)()
    SERVER_PROVIDERS = buildServerProviders(openCodeModels)
  } catch (error) {
    console.warn(`Unable to discover OpenCode models: ${error instanceof Error ? error.message : String(error)}`)
    SERVER_PROVIDERS = buildServerProviders()
  }
  return SERVER_PROVIDERS
}

export function getServerProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = SERVER_PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

export function normalizeServerModel(provider: AgentProvider, model?: string): string {
  const catalog = getServerProviderCatalog(provider)
  const normalizedModel = provider === "opencode"
    ? normalizeOpenCodeModelId(model, catalog.defaultModel)
    : normalizeProviderModelId(provider, model, catalog.defaultModel)
  if (catalog.models.some((candidate) => candidate.id === normalizedModel)) {
    return normalizedModel
  }
  return catalog.defaultModel
}

export function normalizeClaudeModelOptions(
  model: string,
  modelOptions?: ModelOptions,
  legacyEffort?: string
): ClaudeModelOptions {
  const reasoningEffort = modelOptions?.claude?.reasoningEffort
  return {
    reasoningEffort: isClaudeReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isClaudeReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort,
    contextWindow: normalizeClaudeContextWindow(model, modelOptions?.claude?.contextWindow as ClaudeContextWindow | undefined),
  }
}

export function normalizeCodexModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): CodexModelOptions {
  const reasoningEffort = modelOptions?.codex?.reasoningEffort
  return {
    reasoningEffort: isCodexReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isCodexReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CODEX_MODEL_OPTIONS.reasoningEffort,
    fastMode: typeof modelOptions?.codex?.fastMode === "boolean"
      ? modelOptions.codex.fastMode
      : DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
  }
}

export function normalizeHermesModelOptions(): HermesModelOptions {
  return { ...DEFAULT_HERMES_MODEL_OPTIONS }
}

export function normalizeOpenCodeModelOptions(): OpenCodeModelOptions {
  return { ...DEFAULT_OPENCODE_MODEL_OPTIONS }
}

export function codexServiceTierFromModelOptions(modelOptions: CodexModelOptions): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}
