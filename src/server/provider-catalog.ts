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
const DEFAULT_OPENCODE_MODEL_PROVIDERS = ["opencode-go"] as const

export interface ClaudeSdkModelInfo {
  value: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
}

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

export function resetServerProvidersForTests() {
  SERVER_PROVIDERS = buildServerProviders()
}

export function parseOpenCodeModelsOutput(output: string, providerIds?: readonly string[]): ProviderModelOption[] {
  const seen = new Set<string>()
  const models: ProviderModelOption[] = []
  const allowedProviders = providerIds?.length ? new Set(providerIds) : null

  for (const line of output.split(/\r?\n/)) {
    const modelId = line.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\s+/)[0]
    if (!modelId || !modelId.includes("/") || seen.has(modelId)) {
      continue
    }
    if (allowedProviders && !allowedProviders.has(modelId.slice(0, modelId.indexOf("/")))) {
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

async function runOpenCodeModelsCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(`Timed out while running ${command} ${args.join(" ")}`))
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
        reject(new Error(`${command} ${args.join(" ")} exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
        return
      }
      resolve(stdout)
    })
  })
}

export async function discoverOpenCodeModels(options?: {
  command?: string
  timeoutMs?: number
  providerIds?: readonly string[]
}): Promise<ProviderModelOption[]> {
  const command = options?.command ?? "opencode"
  const timeoutMs = options?.timeoutMs ?? 5_000
  const providerIds = options?.providerIds ?? DEFAULT_OPENCODE_MODEL_PROVIDERS
  const output = await runOpenCodeModelsCommand(command, ["models"], timeoutMs)

  return parseOpenCodeModelsOutput(output, providerIds)
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

function modelFamily(value: string) {
  const match = value.match(/^(?:claude-)?([a-z]+)(?:-|$)/i)
  return match?.[1]?.toLowerCase() ?? value.toLowerCase()
}

function sdkModelMatchScore(model: ClaudeSdkModelInfo, option: ProviderModelOption) {
  const modelValue = model.value.toLowerCase()
  if (modelValue === option.id.toLowerCase()) return 3
  if (option.aliases?.some((alias) => alias.toLowerCase() === modelValue)) return 2
  const optionKeys = [option.id, ...(option.aliases ?? [])].map(modelFamily)
  return optionKeys.includes(modelFamily(model.value)) ? 1 : 0
}

function findSdkModelForOption(models: readonly ClaudeSdkModelInfo[], option: ProviderModelOption) {
  let bestModel: ClaudeSdkModelInfo | undefined
  let bestScore = 0
  for (const model of models) {
    const score = sdkModelMatchScore(model, option)
    if (score > bestScore) {
      bestModel = model
      bestScore = score
    }
  }
  return bestModel
}

export function applyClaudeSdkModels(models: readonly ClaudeSdkModelInfo[]) {
  const claudeIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "claude")
  const claudeProvider = SERVER_PROVIDERS[claudeIndex]
  if (!claudeProvider) return false

  const nextModels = claudeProvider.models.map((option) => {
    const sdkModel = findSdkModelForOption(models, option)
    if (!sdkModel) return option
    return {
      ...option,
      label: sdkModel.displayName?.trim() || option.label,
      supportsEffort: sdkModel.supportsEffort ?? option.supportsEffort,
    }
  })

  if (JSON.stringify(nextModels) === JSON.stringify(claudeProvider.models)) {
    return false
  }

  SERVER_PROVIDERS.splice(claudeIndex, 1, {
    ...claudeProvider,
    models: nextModels,
  })
  return true
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
