import { spawn } from "node:child_process"
import type {
  AgentProvider,
  ClaudeModelOptions,
  CodexModelOptions,
  ClaudeContextWindow,
  CursorModelOptions,
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
  DEFAULT_CURSOR_MODEL,
  DEFAULT_CURSOR_MODEL_OPTIONS,
  DEFAULT_HERMES_MODEL_OPTIONS,
  DEFAULT_OPENCODE_MODEL_OPTIONS,
  PROVIDERS,
  normalizeClaudeContextWindow,
  normalizeCursorModelId,
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
const FALLBACK_CURSOR_MODELS: ProviderModelOption[] = [
  { id: "auto", label: "Auto", supportsEffort: false },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast", supportsEffort: false },
  { id: "composer-2.5", label: "Composer 2.5", supportsEffort: false },
]
const DEFAULT_OPENCODE_MODEL_PROVIDERS = ["opencode-go"] as const

function getDefaultCursorModel(cursorModels?: ProviderModelOption[]) {
  return cursorModels?.find((model) => model.label.toLowerCase().includes("(default)"))?.id
    ?? cursorModels?.find((model) => model.id === "auto")?.id
    ?? cursorModels?.find((model) => model.id === "composer-2.5-fast")?.id
    ?? cursorModels?.find((model) => model.label.toLowerCase().includes("(current)"))?.id
    ?? cursorModels?.find((model) => model.id === "composer-2.5")?.id
    ?? cursorModels?.[0]?.id
    ?? DEFAULT_CURSOR_MODEL
}

function buildServerProviders(openCodeModels?: ProviderModelOption[], cursorModels?: ProviderModelOption[]): ProviderCatalogEntry[] {
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
    if (provider.id === "cursor") {
      const models = cursorModels?.length ? cursorModels : FALLBACK_CURSOR_MODELS
      return {
        ...provider,
        defaultModel: getDefaultCursorModel(models),
        models,
      }
    }
    return provider
  })
}

export let SERVER_PROVIDERS: ProviderCatalogEntry[] = buildServerProviders()

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

export function parseCursorModelsOutput(output: string): ProviderModelOption[] {
  const seen = new Set<string>()
  const models: ProviderModelOption[] = []

  for (const line of output.split(/\r?\n/)) {
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, "").trim()
    const match = /^([^\s]+)\s+-\s+(.+)$/.exec(cleanLine)
    if (!match) continue
    const [, id, label] = match
    if (!id || !label || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label,
      supportsEffort: false,
    })
  }

  return models
}

async function runCursorModelsCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return runOpenCodeModelsCommand(command, args, timeoutMs)
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

export async function discoverCursorModels(options?: {
  command?: string
  timeoutMs?: number
}): Promise<ProviderModelOption[]> {
  const command = options?.command ?? "agent"
  const timeoutMs = options?.timeoutMs ?? 5_000
  const output = await runCursorModelsCommand(command, ["models"], timeoutMs)
  const models = parseCursorModelsOutput(output)

  return models.length ? models : FALLBACK_CURSOR_MODELS
}

export async function refreshServerProviderCatalog(options?: {
  discoverOpenCodeModels?: () => Promise<ProviderModelOption[]>
  discoverCursorModels?: () => Promise<ProviderModelOption[]>
}): Promise<ProviderCatalogEntry[]> {
  let openCodeModels: ProviderModelOption[] | undefined
  let cursorModels: ProviderModelOption[] | undefined

  try {
    openCodeModels = await (options?.discoverOpenCodeModels ?? discoverOpenCodeModels)()
  } catch (error) {
    console.warn(`Unable to discover OpenCode models: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    cursorModels = await (options?.discoverCursorModels ?? discoverCursorModels)()
  } catch (error) {
    console.warn(`Unable to discover Cursor models: ${error instanceof Error ? error.message : String(error)}`)
    cursorModels = FALLBACK_CURSOR_MODELS
  }
  SERVER_PROVIDERS = buildServerProviders(openCodeModels, cursorModels)
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
    : provider === "cursor"
      ? normalizeCursorModelId(model, catalog.defaultModel)
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

export function normalizeCursorModelOptions(): CursorModelOptions {
  return { ...DEFAULT_CURSOR_MODEL_OPTIONS }
}

export function codexServiceTierFromModelOptions(modelOptions: CodexModelOptions): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}
