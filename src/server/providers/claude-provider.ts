import { applyClaudeSdkModels } from "../provider-catalog"
import { resolveClaudeApiModelId } from "../../shared/types"
import {
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeServerModel,
} from "../provider-catalog"
import { buildPromptText } from "../prompt-text"
import type { HarnessTurn } from "../harness-types"
import {
  type ClaudeSessionHandle,
  startClaudeSession,
  timestampTranscriptEntry,
} from "./claude-session"
import { logSendToStartingProfile } from "./profiling"
import type {
  ProviderActiveTurnContext,
  ProviderHost,
  ProviderTurnContext,
  ProviderTurnResult,
  SendMessageOptions,
  ServerProviderAdapter,
  ServerProviderCapabilities,
} from "./types"

const CLAUDE_CAPABILITIES: ServerProviderCapabilities = {
  canFork: true,
  supportsPlanMode: true,
  initialActiveStatus: "running",
  drivesTurnViaBackgroundSession: true,
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  pendingPromptSeqs: number[]
}

function isClaudeSteerLoggingEnabled() {
  return process.env.KANNA_LOG_CLAUDE_STEER === "1"
}

export function logClaudeSteer(stage: string, details?: Record<string, unknown>) {
  if (!isClaudeSteerLoggingEnabled()) return
  console.log("[kanna/claude-steer]", JSON.stringify({
    stage,
    ...details,
  }))
}

export type StartClaudeSessionFn = typeof startClaudeSession

export class ClaudeProviderAdapter implements ServerProviderAdapter {
  readonly id = "claude" as const
  readonly capabilities = CLAUDE_CAPABILITIES

  private readonly sessions = new Map<string, ClaudeSessionState>()
  private readonly startClaudeSessionFn: StartClaudeSessionFn

  constructor(
    private readonly host: ProviderHost,
    args: { startClaudeSession?: StartClaudeSessionFn } = {},
  ) {
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
  }

  resolveSettings(options: SendMessageOptions) {
    const catalog = getServerProviderCatalog("claude")
    const model = normalizeServerModel("claude", options.model)
    const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
    return {
      model: resolveClaudeApiModelId(model, modelOptions.contextWindow),
      effort: modelOptions.reasoningEffort,
      serviceTier: undefined,
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
    }
  }

  async startTurn(ctx: ProviderTurnContext): Promise<ProviderTurnResult> {
    logSendToStartingProfile(ctx.profile, "start_turn.provider_boot.begin", {
      chatId: ctx.chatId,
      provider: this.id,
      model: ctx.model,
    })

    const sessionToken = ctx.pendingForkSessionToken ?? ctx.sessionToken
    const forkSession = Boolean(ctx.pendingForkSessionToken)
    const turn = await this.ensureClaudeTurn({
      chatId: ctx.chatId,
      localPath: ctx.localPath,
      model: ctx.model,
      effort: ctx.effort,
      planMode: ctx.planMode,
      sessionToken,
      forkSession,
      onToolRequest: ctx.onToolRequest,
    })

    logSendToStartingProfile(ctx.profile, "start_turn.provider_boot.ready", {
      chatId: ctx.chatId,
      provider: this.id,
      model: ctx.model,
    })

    return {
      turn,
      activate: async (active: ProviderActiveTurnContext) => {
        const session = this.sessions.get(ctx.chatId)
        if (!session) {
          throw new Error("Claude session was not initialized")
        }
        const promptSeq = session.nextPromptSeq + 1
        session.nextPromptSeq = promptSeq
        session.pendingPromptSeqs.push(promptSeq)
        active.setClaudePromptSeq(promptSeq)
        logClaudeSteer("claude_prompt_sent", {
          chatId: ctx.chatId,
          sessionId: session.id,
          promptSeq,
          contentPreview: ctx.content.slice(0, 160),
          pendingPromptSeqs: [...session.pendingPromptSeqs],
        })
        await session.session.sendPrompt(buildPromptText(ctx.content, ctx.attachments))
        logSendToStartingProfile(ctx.profile, "start_turn.claude_prompt_sent", {
          chatId: ctx.chatId,
        })
      },
    }
  }

  stopChat(chatId: string): void {
    const session = this.sessions.get(chatId)
    if (!session) return
    session.session.close()
    this.sessions.delete(chatId)
  }

  stopAll(): void {
    for (const [chatId, session] of this.sessions.entries()) {
      session.session.close()
      this.sessions.delete(chatId)
    }
  }

  shouldSkipAccountInfo(chatId: string): boolean {
    const session = this.sessions.get(chatId)
    if (!session) return true
    if (session.accountInfoLoaded) return true
    session.accountInfoLoaded = true
    return false
  }

  private refreshClaudeModelCatalog(session: ClaudeSessionHandle) {
    if (!session.supportedModels) return
    void session.supportedModels()
      .then((models) => {
        if (applyClaudeSdkModels(models)) {
          this.host.onClaudeModelCatalogRefresh()
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.host.reportBackgroundError(`[claude-models] failed to refresh Claude model catalog: ${message}`)
      })
  }

  private async ensureClaudeTurn(args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: ProviderTurnContext["onToolRequest"]
  }): Promise<HarnessTurn> {
    let session = this.sessions.get(args.chatId)

    if (!session || session.localPath !== args.localPath || session.effort !== args.effort || args.forkSession) {
      if (session) {
        session.session.close()
        this.sessions.delete(args.chatId)
      }

      const started = await this.startClaudeSessionFn({
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
      })
      this.refreshClaudeModelCatalog(started)

      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: started,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
      }
      this.sessions.set(args.chatId, session)
      void this.runClaudeSession(session)
    } else {
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
    }

    return {
      provider: "claude",
      stream: {
        async *[Symbol.asyncIterator]() {},
      },
      getAccountInfo: session.session.getAccountInfo,
      interrupt: session.session.interrupt,
      close: () => {},
    }
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    try {
      for await (const event of session.session.stream) {
        if (event.type === "session_token" && event.sessionToken) {
          session.sessionToken = event.sessionToken
          await this.host.setSessionToken(session.chatId, event.sessionToken)
          this.host.emitStateChange(session.chatId)
          continue
        }

        if (!event.entry) continue
        await this.host.appendMessage(session.chatId, event.entry)
        const active = this.host.getActiveTurn(session.chatId)
        if (event.entry.kind === "system_init" && active) {
          active.status = "running"
          const chat = this.host.getChat(session.chatId)
          if (
            chat?.pendingForkSessionToken
            && session.sessionToken
            && session.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.host.setPendingForkSessionToken(session.chatId, null)
          }
          logClaudeSteer("claude_event_system_init", {
            chatId: session.chatId,
            sessionId: session.id,
            activePromptSeq: active.claudePromptSeq ?? null,
            pendingPromptSeqs: [...session.pendingPromptSeqs],
          })
        }

        const completedClaudePromptSeq = event.entry.kind === "result" || event.entry.kind === "interrupted"
          ? (session.pendingPromptSeqs.shift() ?? null)
          : null

        logClaudeSteer("claude_event", {
          chatId: session.chatId,
          sessionId: session.id,
          entryKind: event.entry.kind,
          activePromptSeq: active?.claudePromptSeq ?? null,
          completedPromptSeq: completedClaudePromptSeq,
          activeStatus: active?.status ?? null,
          pendingPromptSeqs: [...session.pendingPromptSeqs],
        })

        if (event.entry.kind === "result" && active && completedClaudePromptSeq === (active.claudePromptSeq ?? null)) {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.host.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
          } else if (event.entry.subtype === "cancelled") {
            await this.host.recordTurnCancelled(session.chatId, {
              reason: "provider_reported_cancelled",
              detail: event.entry.result || undefined,
            })
            active.cancelRecorded = true
          } else if (!active.cancelRequested) {
            await this.host.recordTurnFinished(session.chatId)
          }
          this.host.removeActiveTurn(session.chatId)
          this.host.markActivity()
          if (!active.cancelRequested) {
            await this.host.maybeStartNextQueuedMessage(session.chatId)
          }
        }

        if (event.entry.kind === "interrupted" && active && completedClaudePromptSeq === (active.claudePromptSeq ?? null)) {
          active.hasFinalResult = true
          await this.host.recordTurnCancelled(session.chatId, {
            reason: event.entry.reason ?? "provider_reported_cancelled",
            detail: event.entry.detail,
          })
          active.cancelRecorded = true
          this.host.removeActiveTurn(session.chatId)
          this.host.markActivity()
          if (!active.cancelRequested) {
            await this.host.maybeStartNextQueuedMessage(session.chatId)
          }
        }

        this.host.emitStateChange(session.chatId)
      }
    } catch (error) {
      const active = this.host.getActiveTurn(session.chatId)
      if (active && !active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.host.appendMessage(
          session.chatId,
          timestampTranscriptEntry({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.host.recordTurnFailed(session.chatId, message)
      }
    } finally {
      this.sessions.delete(session.chatId)
      const active = this.host.getActiveTurn(session.chatId)
      if (active) {
        if (active.cancelRequested && !active.cancelRecorded) {
          await this.host.recordTurnCancelled(session.chatId, {
            reason: active.cancelReason ?? "unknown",
            detail: active.cancelDetail,
          })
        }
        this.host.removeActiveTurn(session.chatId)
        this.host.markActivity()
      }
      session.session.close()
      this.host.emitStateChange(session.chatId)
    }
  }
}
