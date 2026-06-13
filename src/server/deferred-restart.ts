import { LOG_PREFIX } from "../shared/branding"

export interface IdleState {
  idle: boolean
  lastActivityAt: number
}

interface DeferredRestartControllerOptions {
  getIdleState: () => IdleState
  restart: () => void
  log?: (message: string) => void
  intervalMs?: number
  idleGraceMs?: number
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export function createDeferredRestartController(options: DeferredRestartControllerOptions) {
  const log = options.log ?? console.log
  const intervalMs = options.intervalMs ?? 1000
  const idleGraceMs = options.idleGraceMs ?? 2 * 60 * 1000
  const now = options.now ?? Date.now
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  let restartRequested = false
  let checkInterval: ReturnType<typeof setInterval> | null = null
  let idleGraceTimeout: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (checkInterval) {
      clearIntervalFn(checkInterval)
      checkInterval = null
    }
    if (idleGraceTimeout) {
      clearTimeoutFn(idleGraceTimeout)
      idleGraceTimeout = null
    }
  }

  function restartNow(reason: string) {
    log(`${LOG_PREFIX} ${reason}, restarting now`)
    clear()
    options.restart()
  }

  function cancelIdleGrace() {
    if (!idleGraceTimeout) return
    clearTimeoutFn(idleGraceTimeout)
    idleGraceTimeout = null
  }

  function scheduleIdleGrace(delayMs: number) {
    if (idleGraceTimeout) return
    idleGraceTimeout = setTimeoutFn(() => {
      idleGraceTimeout = null
      checkRestartConditions()
    }, delayMs)
  }

  function checkRestartConditions() {
    if (!restartRequested) {
      cancelIdleGrace()
      return
    }

    const idleState = options.getIdleState()
    if (!idleState.idle) {
      cancelIdleGrace()
      return
    }

    const idleForMs = Math.max(0, now() - idleState.lastActivityAt)
    if (idleForMs >= idleGraceMs) {
      restartRequested = false
      restartNow("deferred restart idle grace period elapsed")
      return
    }

    scheduleIdleGrace(idleGraceMs - idleForMs)
  }

  function request(reason: string) {
    if (!restartRequested) {
      log(`${LOG_PREFIX} ${reason}, deferring restart until active sessions are idle`)
    }
    restartRequested = true

    checkRestartConditions()

    if (checkInterval) return
    checkInterval = setIntervalFn(checkRestartConditions, intervalMs)
  }

  return {
    request,
    clear,
    get pending() {
      return restartRequested
    },
  }
}
