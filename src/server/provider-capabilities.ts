import type { AgentProvider } from "../shared/types"

export function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`)
}

export const SERVER_PROVIDER_CAPABILITIES = {
  claude: {
    canFork: true,
    supportsPlanMode: true,
  },
  codex: {
    canFork: true,
    supportsPlanMode: true,
  },
  opencode: {
    canFork: false,
    supportsPlanMode: false,
  },
} as const satisfies Record<AgentProvider, {
  canFork: boolean
  supportsPlanMode: boolean
}>

export function providerCanFork(provider: AgentProvider | string): boolean {
  const capabilities = SERVER_PROVIDER_CAPABILITIES[provider as AgentProvider]
  return capabilities?.canFork ?? false
}
