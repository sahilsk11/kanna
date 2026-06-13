import {
  codexServiceTierFromModelOptions,
  getServerProviderCatalog,
  normalizeCodexModelOptions,
  normalizeServerModel,
} from "../provider-catalog"
import type { CodexAppServerManager } from "../codex-app-server"
import { buildPromptText } from "../prompt-text"
import { logSendToStartingProfile } from "./profiling"
import type {
  ProviderTurnContext,
  ProviderTurnResult,
  SendMessageOptions,
  ServerProviderAdapter,
  ServerProviderCapabilities,
} from "./types"

const CODEX_CAPABILITIES: ServerProviderCapabilities = {
  canFork: true,
  supportsPlanMode: true,
  initialActiveStatus: "starting",
  drivesTurnViaBackgroundSession: false,
}

export class CodexProviderAdapter implements ServerProviderAdapter {
  readonly id = "codex" as const
  readonly capabilities = CODEX_CAPABILITIES

  constructor(private readonly manager: CodexAppServerManager) {}

  resolveSettings(options: SendMessageOptions) {
    const catalog = getServerProviderCatalog("codex")
    const modelOptions = normalizeCodexModelOptions(options.modelOptions, options.effort)
    return {
      model: normalizeServerModel("codex", options.model),
      effort: modelOptions.reasoningEffort,
      serviceTier: codexServiceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
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
      model: ctx.model,
      serviceTier: ctx.serviceTier,
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
      effort: ctx.effort as any,
      serviceTier: ctx.serviceTier,
      planMode: ctx.planMode,
      onToolRequest: ctx.onToolRequest,
    })
    logSendToStartingProfile(ctx.profile, "start_turn.provider_boot.ready", {
      chatId: ctx.chatId,
      provider: this.id,
      model: ctx.model,
    })
    return { turn }
  }

  stopChat(_chatId: string): void {
    // Codex sessions are long-lived across turns; torn down on stopAll or replacement.
  }

  stopAll(): void {
    this.manager.stopAll()
  }

  onCancelPendingTool(tool: { toolKind: string }) {
    return tool.toolKind === "exit_plan_mode" ? "resolve" as const : "discard" as const
  }

  onExitPlanModeResponse(result: unknown) {
    const record = (result ?? {}) as {
      confirmed?: boolean
      clearContext?: boolean
      message?: string
    }
    return record.confirmed
      ? {
          content: record.message
            ? `Proceed with the approved plan. Additional guidance: ${record.message}`
            : "Proceed with the approved plan.",
          planMode: false,
        }
      : {
          content: record.message
            ? `Revise the plan using this feedback: ${record.message}`
            : "Revise the plan using this feedback.",
          planMode: true,
        }
  }
}
