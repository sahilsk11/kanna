import type { AgentProvider } from "../../shared/types"
import type { CodexAppServerManager } from "../codex-app-server"
import type { OpenCodeServerManager } from "../opencode-server"
import { CodexAppServerManager as DefaultCodexManager } from "../codex-app-server"
import { OpenCodeServerManager as DefaultOpenCodeManager } from "../opencode-server"
import { ClaudeProviderAdapter, type StartClaudeSessionFn } from "./claude-provider"
import { CodexProviderAdapter } from "./codex-provider"
import { OpenCodeProviderAdapter } from "./opencode-provider"
import { ServerProviderRegistry } from "./registry"
import type { ProviderHost, ServerProviderAdapter } from "./types"

export interface CreateServerProvidersArgs {
  host: ProviderHost
  codexManager?: CodexAppServerManager
  opencodeManager?: OpenCodeServerManager
  startClaudeSession?: StartClaudeSessionFn
  adapters?: Partial<Record<AgentProvider, ServerProviderAdapter>>
}

export function createServerProviders(args: CreateServerProvidersArgs): ServerProviderRegistry {
  const codexManager = args.codexManager ?? new DefaultCodexManager()
  const opencodeManager = args.opencodeManager ?? new DefaultOpenCodeManager()

  return new ServerProviderRegistry([
    ["claude", args.adapters?.claude ?? new ClaudeProviderAdapter(args.host, {
      startClaudeSession: args.startClaudeSession,
    })],
    ["codex", args.adapters?.codex ?? new CodexProviderAdapter(codexManager)],
    ["opencode", args.adapters?.opencode ?? new OpenCodeProviderAdapter(opencodeManager)],
  ])
}

export function providerCanForkFromRegistry(registry: ServerProviderRegistry, provider: AgentProvider): boolean {
  return registry.require(provider).capabilities.canFork
}
