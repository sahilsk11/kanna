import type { AgentProvider } from "../../shared/types"
import type { ServerProviderAdapter } from "./types"

export class ServerProviderRegistry {
  private readonly adapters: Map<AgentProvider, ServerProviderAdapter>

  constructor(adapters: Iterable<[AgentProvider, ServerProviderAdapter]>) {
    this.adapters = new Map(adapters)
  }

  get(provider: AgentProvider): ServerProviderAdapter | undefined {
    return this.adapters.get(provider)
  }

  require(provider: AgentProvider): ServerProviderAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new Error(`Unsupported provider: ${provider}`)
    }
    return adapter
  }

  values(): Iterable<ServerProviderAdapter> {
    return this.adapters.values()
  }
}

export function providerCanFork(registry: ServerProviderRegistry, provider: AgentProvider): boolean {
  return registry.require(provider).capabilities.canFork
}
