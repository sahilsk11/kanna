import type { SendToStartingProfile } from "./types"

function isSendToStartingProfilingEnabled() {
  return process.env.KANNA_PROFILE_SEND_TO_STARTING === "1"
}

function elapsedProfileMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

export function logSendToStartingProfile(
  profile: SendToStartingProfile | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!profile || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[kanna/send->starting][server]", JSON.stringify({
    traceId: profile.traceId,
    stage,
    elapsedMs: elapsedProfileMs(profile.startedAt),
    ...details,
  }))
}
