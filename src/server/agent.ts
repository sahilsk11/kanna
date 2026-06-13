import type {
  AgentProvider,
  ChatAttachment,
  InterruptedReason,
  NormalizedToolCall,
  PendingToolSnapshot,
  KannaStatus,
  QueuedChatMessage,
  TranscriptEntry,
} from "../shared/types"
import type { ClientCommand } from "../shared/protocol"
import { EventStore } from "./event-store"
import type { AnalyticsReporter } from "./analytics"
import { NoopAnalyticsReporter } from "./analytics"
import type { CodexAppServerManager } from "./codex-app-server"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import type { HarnessToolRequest, HarnessTurn } from "./harness-types"
import type { OpenCodeServerManager } from "./opencode-server"
import { fallbackTitleFromMessage } from "./generate-title"
import { logClaudeSteer } from "./providers/claude-provider"
import {
  type ClaudeSessionHandle,
} from "./providers/claude-session"
import { createServerProviders } from "./providers/create-providers"
import { logSendToStartingProfile } from "./providers/profiling"
import type { ServerProviderRegistry } from "./providers/registry"
import type {
  ProviderHost,
  SendMessageOptions,
  SendToStartingProfile,
} from "./providers/types"

export {
  buildAttachmentHintText,
  buildPromptText,
} from "./prompt-text"
export {
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeStreamMessage,
  normalizeClaudeUsageSnapshot,
} from "./providers/claude-session"

const STEERED_MESSAGE_PREFIX = `<system-message>
The user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.
</system-message>`

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
  resolve: (result: unknown) => void
}

interface ActiveTurn {
  chatId: string
  provider: AgentProvider
  turn: HarnessTurn
  claudePromptSeq?: number
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  status: KannaStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelReason?: InterruptedReason
  cancelDetail?: string
  cancelRecorded: boolean
  clientTraceId?: string
  profilingStartedAt?: number
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  analytics?: AnalyticsReporter
  providers?: ServerProviderRegistry
  codexManager?: CodexAppServerManager
  opencodeManager?: OpenCodeServerManager
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  }) => Promise<ClaudeSessionHandle>
}

interface CancelOptions {
  hideInterrupted?: boolean
  reason?: InterruptedReason
  detail?: string
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function buildSteeredMessageContent(content: string) {
  return content.trim().length > 0
    ? `${STEERED_MESSAGE_PREFIX}\n\n${content}`
    : STEERED_MESSAGE_PREFIX
}

function discardedToolResult(
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
) {
  if (tool.toolKind === "ask_user_question") {
    return {
      discarded: true,
      answers: {},
    }
  }

  return {
    discarded: true,
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly analytics: AnalyticsReporter
  private readonly providers: ServerProviderRegistry
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private reportBackgroundError: ((message: string) => void) | null = null
  readonly activeTurns = new Map<string, ActiveTurn>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  private lastActivityAt = Date.now()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.analytics = args.analytics ?? NoopAnalyticsReporter
    this.generateTitle = args.generateTitle ?? generateTitleForChatDetailed
    this.providers = args.providers ?? createServerProviders({
      host: this.createProviderHost(),
      codexManager: args.codexManager,
      opencodeManager: args.opencodeManager,
      startClaudeSession: args.startClaudeSession,
    })
  }

  private createProviderHost(): ProviderHost {
    return {
      appendMessage: async (chatId, entry) => {
        await this.store.appendMessage(chatId, entry)
      },
      setSessionToken: async (chatId, token) => {
        await this.store.setSessionToken(chatId, token)
      },
      setPendingForkSessionToken: async (chatId, token) => {
        await this.store.setPendingForkSessionToken(chatId, token)
      },
      getChat: (chatId) => this.store.getChat(chatId),
      getActiveTurn: (chatId) => this.activeTurns.get(chatId),
      updateActiveTurn: (chatId, update) => {
        const active = this.activeTurns.get(chatId)
        if (active) update(active)
      },
      removeActiveTurn: (chatId) => {
        this.activeTurns.delete(chatId)
      },
      emitStateChange: (chatId, options) => {
        this.emitStateChange(chatId, options)
      },
      recordTurnFailed: async (chatId, message) => {
        await this.store.recordTurnFailed(chatId, message)
      },
      recordTurnCancelled: async (chatId, options) => {
        await this.store.recordTurnCancelled(chatId, options)
      },
      recordTurnFinished: async (chatId) => {
        await this.store.recordTurnFinished(chatId)
      },
      maybeStartNextQueuedMessage: async (chatId) => {
        return await this.maybeStartNextQueuedMessage(chatId)
      },
      markActivity: () => {
        this.markActivity()
      },
      reportBackgroundError: (message) => {
        this.reportBackgroundError?.(message)
      },
      onClaudeModelCatalogRefresh: () => {
        this.emitStateChange(undefined, { immediate: true })
      },
    }
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }

  getActiveStatuses() {
    const statuses = new Map<string, KannaStatus>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return { toolUseId: pending.toolUseId, toolKind: pending.tool.toolKind }
  }

  getDrainingChatIds(): Set<string> {
    return new Set(this.drainingStreams.keys())
  }

  isIdle() {
    return this.activeTurns.size === 0 && this.drainingStreams.size === 0
  }

  getIdleState() {
    return {
      idle: this.isIdle(),
      lastActivityAt: this.lastActivityAt,
    }
  }

  private markActivity() {
    this.lastActivityAt = Date.now()
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  getActiveTurnProfile(chatId: string): SendToStartingProfile | null {
    const active = this.activeTurns.get(chatId)
    if (!active?.clientTraceId || active.profilingStartedAt === undefined) {
      return null
    }

    return {
      traceId: active.clientTraceId,
      startedAt: active.profilingStartedAt,
    }
  }

  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.drainingStreams.delete(chatId)
    this.markActivity()
    this.emitStateChange(chatId)
  }

  async closeChat(chatId: string) {
    await this.stopDraining(chatId)
    this.providers.require("claude").stopChat(chatId)
    this.providers.require("opencode").stopChat(chatId)
    this.emitStateChange(chatId)
  }

  async stopAll() {
    for (const chatId of [...this.drainingStreams.keys()]) {
      await this.stopDraining(chatId)
    }
    for (const chatId of [...this.activeTurns.keys()]) {
      await this.cancel(chatId, { reason: "server_shutdown" })
    }
    for (const adapter of this.providers.values()) {
      adapter.stopAll()
    }
    this.emitStateChange()
  }

  private resolveProvider(options: SendMessageOptions, currentProvider: AgentProvider | null) {
    if (currentProvider) return currentProvider
    return options.provider ?? "claude"
  }

  private async enqueueMessage(chatId: string, content: string, attachments: ChatAttachment[], options?: SendMessageOptions) {
    const queued = await this.store.enqueueMessage(chatId, {
      content,
      attachments,
      provider: options?.provider,
      model: options?.model,
      modelOptions: options?.modelOptions,
      planMode: options?.planMode,
    })
    this.emitStateChange(chatId)
    return queued
  }

  private async dequeueAndStartQueuedMessage(chatId: string, queuedMessage: QueuedChatMessage, options?: { steered?: boolean }) {
    await this.store.removeQueuedMessage(chatId, queuedMessage.id)
    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(queuedMessage, chat.provider)
    const adapter = this.providers.require(provider)
    const settings = adapter.resolveSettings(queuedMessage)
    await this.startTurnForChat({
      chatId,
      provider,
      content: options?.steered ? buildSteeredMessageContent(queuedMessage.content) : queuedMessage.content,
      attachments: queuedMessage.attachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      steered: options?.steered,
    })
  }

  private async maybeStartNextQueuedMessage(chatId: string) {
    if (this.activeTurns.has(chatId)) return false
    const nextQueuedMessage = typeof this.store.getQueuedMessages === "function"
      ? this.store.getQueuedMessages(chatId)[0]
      : undefined
    if (!nextQueuedMessage) return false
    await this.dequeueAndStartQueuedMessage(chatId, nextQueuedMessage)
    return true
  }

  private async startTurnForChat(args: {
    chatId: string
    provider: AgentProvider
    content: string
    attachments: ChatAttachment[]
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    appendUserPrompt: boolean
    steered?: boolean
    profile?: SendToStartingProfile | null
  }) {
    logSendToStartingProfile(args.profile, "start_turn.begin", {
      chatId: args.chatId,
      provider: args.provider,
      appendUserPrompt: args.appendUserPrompt,
      planMode: args.planMode,
    })

    // Close any lingering draining stream before starting a new turn.
    const draining = this.drainingStreams.get(args.chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(args.chatId)
      this.markActivity()
    }

    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId)) {
      throw new Error("Chat is already running")
    }

    if (!chat.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
      logSendToStartingProfile(args.profile, "start_turn.provider_set", {
        chatId: args.chatId,
        provider: args.provider,
      })
    }
    await this.store.setPlanMode(args.chatId, args.planMode)
    logSendToStartingProfile(args.profile, "start_turn.plan_mode_set", {
      chatId: args.chatId,
      planMode: args.planMode,
    })

    const existingMessages = this.store.getMessages(args.chatId)
    const shouldGenerateTitle = args.appendUserPrompt && chat.title === "New Chat" && existingMessages.length === 0
    const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null

    if (optimisticTitle) {
      await this.store.renameChat(args.chatId, optimisticTitle)
      logSendToStartingProfile(args.profile, "start_turn.optimistic_title_set", {
        chatId: args.chatId,
        title: optimisticTitle,
      })
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    if (args.appendUserPrompt) {
      const userPromptEntry = timestamped(
        { kind: "user_prompt", content: args.content, attachments: args.attachments, steered: args.steered },
        Date.now()
      )
      await this.store.appendMessage(args.chatId, userPromptEntry)
      logSendToStartingProfile(args.profile, "start_turn.user_prompt_appended", {
        chatId: args.chatId,
        entryId: userPromptEntry._id,
      })
    }
    await this.store.recordTurnStarted(args.chatId)
    logSendToStartingProfile(args.profile, "start_turn.turn_started_recorded", {
      chatId: args.chatId,
    })

    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat")
    }

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      const active = this.activeTurns.get(args.chatId)
      if (!active) {
        throw new Error("Chat turn ended unexpectedly")
      }

      active.status = "waiting_for_user"
      this.emitStateChange(args.chatId)

      return await new Promise<unknown>((resolve) => {
        active.pendingTool = {
          toolUseId: request.tool.toolId,
          tool: request.tool,
          resolve,
        }
      })
    }

    const adapter = this.providers.require(args.provider)

    const { turn, activate } = await adapter.startTurn({
      chatId: args.chatId,
      localPath: project.localPath,
      content: args.content,
      attachments: args.attachments,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      sessionToken: chat.sessionToken,
      pendingForkSessionToken: chat.pendingForkSessionToken ?? null,
      onToolRequest,
      profile: args.profile,
      clearPendingForkSessionToken: async () => {
        await this.store.setPendingForkSessionToken(args.chatId, null)
      },
    })

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      status: adapter.capabilities.initialActiveStatus,
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
      clientTraceId: args.profile?.traceId,
      profilingStartedAt: args.profile?.startedAt,
    }
    this.activeTurns.set(args.chatId, active)
    this.markActivity()
    logSendToStartingProfile(args.profile, "start_turn.active_turn_registered", {
      chatId: args.chatId,
      status: active.status,
    })
    this.emitStateChange(args.chatId, { immediate: active.status === "starting" })
    logSendToStartingProfile(args.profile, "start_turn.state_change_emitted", {
      chatId: args.chatId,
      status: active.status,
    })

    if (turn.getAccountInfo) {
      void turn.getAccountInfo()
        .then(async (accountInfo) => {
          if (!accountInfo) return
          if (adapter.shouldSkipAccountInfo?.(args.chatId)) return
          await this.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo }))
          this.emitStateChange(args.chatId)
        })
        .catch(() => undefined)
    }

    if (activate) {
      await activate({
        chatId: args.chatId,
        setClaudePromptSeq: (seq) => {
          active.claudePromptSeq = seq
        },
      })
      return
    }

    void this.runTurn(active)
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>) {
    const profile = command.clientTraceId
      ? { traceId: command.clientTraceId, startedAt: performance.now() }
      : null
    let chatId = command.chatId

    logSendToStartingProfile(profile, "chat_send.received", {
      existingChatId: command.chatId ?? null,
      projectId: command.projectId ?? null,
    })

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      this.analytics.track("chat_created")
      logSendToStartingProfile(profile, "chat_send.chat_created", {
        chatId,
        projectId: command.projectId,
      })
    }

    const chat = this.store.requireChat(chatId)
    if (this.activeTurns.has(chatId)) {
      this.analytics.track("message_sent")
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    const provider = this.resolveProvider(command, chat.provider)
    const adapter = this.providers.require(provider)
    const settings = adapter.resolveSettings(command)
    this.analytics.track("message_sent")
    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      attachments: command.attachments ?? [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      profile,
    })

    logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
      chatId,
      provider,
      model: settings.model,
    })

    return { chatId }
  }

  async enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>) {
    this.analytics.track("message_sent")
    const queuedMessage = await this.enqueueMessage(command.chatId, command.content, command.attachments ?? [], {
      provider: command.provider,
      model: command.model,
      modelOptions: command.modelOptions,
      planMode: command.planMode,
    })
    return { queuedMessageId: queuedMessage.id }
  }

  async steer(command: Extract<ClientCommand, { type: "message.steer" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }

    logClaudeSteer("steer_requested", {
      chatId: command.chatId,
      queuedMessageId: command.queuedMessageId,
      activeTurn: this.activeTurns.has(command.chatId),
      queuedMessagePreview: queuedMessage.content.slice(0, 160),
    })

    if (this.activeTurns.has(command.chatId)) {
      await this.cancel(command.chatId, { hideInterrupted: true, reason: "steer_replaced_turn" })
    }

    logClaudeSteer("steer_after_cancel", {
      chatId: command.chatId,
      stillActive: this.activeTurns.has(command.chatId),
    })

    if (this.activeTurns.has(command.chatId)) {
      throw new Error("Chat is still running")
    }

    await this.dequeueAndStartQueuedMessage(command.chatId, queuedMessage, { steered: true })
  }

  async dequeue(command: Extract<ClientCommand, { type: "message.dequeue" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }

    await this.store.removeQueuedMessage(command.chatId, command.queuedMessageId)
  }

  async forkChat(chatId: string) {
    const chat = this.store.requireChat(chatId)
    if (this.activeTurns.has(chatId) || this.drainingStreams.has(chatId)) {
      throw new Error("Chat must be idle before forking")
    }
    if (!chat.provider) {
      throw new Error("Chat must have a provider before forking")
    }
    const adapter = this.providers.require(chat.provider)
    if (!adapter.capabilities.canFork) {
      throw new Error(
        adapter.forkNotSupportedMessage?.() ?? `${chat.provider} chats cannot be forked yet`
      )
    }
    if (!chat.sessionToken && !chat.pendingForkSessionToken) {
      throw new Error("Chat has no session to fork")
    }

    const forked = await this.store.forkChat(chatId)
    this.analytics.track("chat_created")
    return { chatId: forked.id }
  }


  private async generateTitleInBackground(chatId: string, messageContent: string, cwd: string, expectedCurrentTitle: string) {
    try {
      const result = await this.generateTitle(messageContent, cwd)
      if (result.failureMessage) {
        this.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed provider title generation: ${result.failureMessage}`
        )
      }
      if (!result.title || result.usedFallback) return

      const chat = this.store.requireChat(chatId)
      if (chat.title !== expectedCurrentTitle) return

      await this.store.renameChat(chatId, result.title)
      this.emitStateChange(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportBackgroundError?.(
        `[title-generation] chat ${chatId} failed background title generation: ${message}`
      )
    }
  }

  private async runTurn(active: ActiveTurn) {
    try {
      for await (const event of active.turn.stream) {
        // Once cancelled, stop processing further stream events.
        // cancel() already removed us from activeTurns and notified the UI.
        if (active.cancelRequested) break

        if (event.type === "session_token" && event.sessionToken) {
          await this.store.setSessionToken(active.chatId, event.sessionToken)
          const chat = this.store.getChat(active.chatId)
          if (
            chat?.pendingForkSessionToken
            && event.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(active.chatId, null)
          }
          this.emitStateChange(active.chatId)
          continue
        }

        if (!event.entry) continue
        await this.store.appendMessage(active.chatId, event.entry)

        if (event.entry.kind === "system_init") {
          active.status = "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (event.entry.subtype === "cancelled") {
            await this.store.recordTurnCancelled(active.chatId, {
              reason: "provider_reported_cancelled",
              detail: event.entry.result || undefined,
            })
            active.cancelRecorded = true
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
          }
          // Remove from activeTurns as soon as the result arrives so the UI
          // transitions to idle immediately. The stream may still be open
          // (e.g. background tasks), but the user should be able to send
          // new messages without having to hit stop first.
          this.activeTurns.delete(active.chatId)
          // Track the still-open stream so the UI can show a draining
          // indicator and the user can stop background tasks.
          this.drainingStreams.set(active.chatId, { turn: active.turn })
          this.markActivity()
        }

        this.emitStateChange(active.chatId)
      }
    } catch (error) {
      if (!active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          active.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.store.recordTurnFailed(active.chatId, message)
      }
    } finally {
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId, {
          reason: active.cancelReason ?? "unknown",
          detail: active.cancelDetail,
        })
      }
      active.turn.close()
      // Only remove if we're still the active turn for this chat.
      // We may have already been removed by result handling or cancel(),
      // and a new turn may have started for the same chatId.
      if (this.activeTurns.get(active.chatId) === active) {
        this.activeTurns.delete(active.chatId)
        this.markActivity()
      }
      // Stream has fully ended — no longer draining.
      if (this.drainingStreams.delete(active.chatId)) {
        this.markActivity()
      }
      this.emitStateChange(active.chatId)

      if (active.postToolFollowUp && !active.cancelRequested) {
        try {
          await this.startTurnForChat({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            attachments: [],
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            appendUserPrompt: false,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      } else if (!active.cancelRequested) {
        try {
          await this.maybeStartNextQueuedMessage(active.chatId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      }
    }
  }

  async cancel(chatId: string, options?: CancelOptions) {
    // Also clean up any draining stream for this chat.
    const draining = this.drainingStreams.get(chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(chatId)
      this.markActivity()
    }

    const active = this.activeTurns.get(chatId)
    if (!active) return

    logClaudeSteer("cancel_requested", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Guard against concurrent cancel() calls — only the first one does work.
    if (active.cancelRequested) return
    active.cancelRequested = true
    active.cancelReason = options?.reason ?? "user_cancelled"
    active.cancelDetail = options?.detail

    const pendingTool = active.pendingTool
    active.pendingTool = null

    if (pendingTool) {
      const result = discardedToolResult(pendingTool.tool)
      await this.store.appendMessage(
        chatId,
        timestamped({
          kind: "tool_result",
          toolId: pendingTool.toolUseId,
          content: result,
        })
      )
      const cancelAction = this.providers.require(active.provider).onCancelPendingTool?.(pendingTool.tool) ?? "discard"
      if (cancelAction === "resolve") {
        pendingTool.resolve(result)
      }
    }

    await this.store.appendMessage(chatId, timestamped({
      kind: "interrupted",
      hidden: options?.hideInterrupted,
      reason: active.cancelReason,
      detail: active.cancelDetail,
    }))
    await this.store.recordTurnCancelled(chatId, {
      reason: active.cancelReason,
      detail: active.cancelDetail,
    })
    active.cancelRecorded = true
    active.hasFinalResult = true

    // Remove from activeTurns immediately so the UI reflects the cancellation
    // right away, rather than waiting for interrupt() which may hang.
    this.activeTurns.delete(chatId)
    this.markActivity()
    this.emitStateChange(chatId)
    logClaudeSteer("cancel_active_turn_deleted", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Now attempt to interrupt/close the underlying stream in the background.
    // This is best-effort — the turn is already removed from active state above,
    // and runTurn()'s finally block will also call close().
    try {
      await Promise.race([
        active.turn.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    } catch {
      // interrupt() failed — force close
    }
    active.turn.close()
  }

  async respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const active = this.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      throw new Error("No pending tool request")
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }

    await this.store.appendMessage(
      command.chatId,
      timestamped({
        kind: "tool_result",
        toolId: command.toolUseId,
        content: command.result,
      })
    )

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        await this.store.setSessionToken(command.chatId, null)
        await this.store.appendMessage(command.chatId, timestamped({ kind: "context_cleared" }))
      }

      const followUp = this.providers.require(active.provider).onExitPlanModeResponse?.(command.result)
      if (followUp) {
        active.postToolFollowUp = followUp
      }
    }

    pending.resolve(command.result)

    this.emitStateChange(command.chatId)
  }
}
