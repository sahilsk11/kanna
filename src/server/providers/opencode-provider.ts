import { normalizeServerModel } from "../provider-catalog"
import type { OpenCodeServerManager } from "../opencode-server"
import { buildPromptText } from "../prompt-text"
import { logSendToStartingProfile } from "./profiling"
import type {
  ProviderTurnContext,
  ProviderTurnResult,
  SendMessageOptions,
  ServerProviderAdapter,
  ServerProviderCapabilities,
} from "./types"

const OPENCODE_CAPABILITIES: ServerProviderCapabilities = {
  canFork: false,
  supportsPlanMode: false,
  initialActiveStatus: "starting",
  drivesTurnViaBackgroundSession: false,
}

export class OpenCodeProviderAdapter implements ServerProviderAdapter {
  readonly id = "opencode" as const
  readonly capabilities = OPENCODE_CAPABILITIES

  constructor(private readonly manager: OpenCodeServerManager) {}

  resolveSettings(options: SendMessageOptions) {
    return {
      model: normalizeServerModel("opencode", options.model),
      effort: undefined,
      serviceTier: undefined,
      planMode: false,
    }
  }

  async startTurn(ctx: ProviderTurnContext): Promise<ProviderTurnResult> {
    logSendToStartingProfile(ctx.profile, "start_turn.provider_boot.begin", {
      chatId: ctx.chatId,
      provider: this.id,
      model: ctx.model,
    })
    const sessionToken = await this.manager.startSession({
      chatId: ctx.chatId,
      cwd: ctx.localPath,
      sessionToken: ctx.sessionToken,
      pendingForkSessionToken: ctx.pendingForkSessionToken,
    })
    if (ctx.pendingForkSessionToken && sessionToken) {
      await ctx.clearPendingForkSessionToken()
    }
    logSendToStartingProfile(ctx.profile, "start_turn.session_ready", {
      chatId: ctx.chatId,
      provider: this.id,
      model: ctx.model,
    })
    const turn = await this.manager.startTurn({
      chatId: ctx.chatId,
      content: buildPromptText(ctx.content, ctx.attachments),
      model: ctx.model,
    })
    logSendToStartingProfile(ctx.profile, "start_turn.provider_boot.ready", {
      chatId: ctx.chatId,
      provider: this.id,
      model: ctx.model,
    })
    return { turn }
  }

  stopChat(chatId: string): void {
    this.manager.stopSession(chatId)
  }

  stopAll(): void {
    this.manager.stopAll()
  }

  forkNotSupportedMessage() {
    return "OpenCode chats cannot be forked yet"
  }
}
