import type {
  AgentProvider,
  ChatAttachment,
  InterruptedReason,
  KannaStatus,
  ModelOptions,
  NormalizedToolCall,
  TranscriptEntry,
} from "../../shared/types"
import type { HarnessToolRequest, HarnessTurn } from "../harness-types"

export interface SendToStartingProfile {
  traceId: string
  startedAt: number
}

export interface SendMessageOptions {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  effort?: string
  planMode?: boolean
}

export interface ProviderSettings {
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
}

export interface ServerProviderCapabilities {
  canFork: boolean
  supportsPlanMode: boolean
  initialActiveStatus: Extract<KannaStatus, "running" | "starting">
  drivesTurnViaBackgroundSession: boolean
}

export interface ProviderTurnContext {
  chatId: string
  localPath: string
  content: string
  attachments: ChatAttachment[]
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  sessionToken: string | null
  pendingForkSessionToken: string | null
  onToolRequest: (req: HarnessToolRequest) => Promise<unknown>
  profile?: SendToStartingProfile | null
  clearPendingForkSessionToken: () => Promise<void>
}

export interface ProviderActiveTurnContext {
  chatId: string
  setClaudePromptSeq: (seq: number) => void
}

export interface ProviderTurnResult {
  turn: HarnessTurn
  activate?: (active: ProviderActiveTurnContext) => Promise<void>
}

export interface ProviderActiveTurnState {
  status: KannaStatus
  claudePromptSeq?: number
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean
  cancelReason?: InterruptedReason
  cancelDetail?: string
}

export interface ProviderHost {
  appendMessage(chatId: string, entry: TranscriptEntry): Promise<void>
  setSessionToken(chatId: string, token: string): Promise<void>
  setPendingForkSessionToken(chatId: string, token: string | null): Promise<void>
  getChat(chatId: string): { pendingForkSessionToken?: string | null } | null
  getActiveTurn(chatId: string): ProviderActiveTurnState | undefined
  updateActiveTurn(chatId: string, update: (active: ProviderActiveTurnState) => void): void
  removeActiveTurn(chatId: string): void
  emitStateChange(chatId?: string, options?: { immediate?: boolean }): void
  recordTurnFailed(chatId: string, message: string): Promise<void>
  recordTurnCancelled(chatId: string, options: { reason: InterruptedReason; detail?: string }): Promise<void>
  recordTurnFinished(chatId: string): Promise<void>
  maybeStartNextQueuedMessage(chatId: string): Promise<boolean>
  markActivity(): void
  reportBackgroundError(message: string): void
  onClaudeModelCatalogRefresh(): void
}

export interface ServerProviderAdapter {
  readonly id: AgentProvider
  readonly capabilities: ServerProviderCapabilities

  resolveSettings(options: SendMessageOptions): ProviderSettings
  startTurn(ctx: ProviderTurnContext): Promise<ProviderTurnResult>
  stopChat(chatId: string): void
  stopAll(): void

  shouldSkipAccountInfo?(chatId: string): boolean
  onCancelPendingTool?(tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }): "resolve" | "discard"
  onExitPlanModeResponse?(result: unknown): { content: string; planMode: boolean } | null
  forkNotSupportedMessage?(): string
}
