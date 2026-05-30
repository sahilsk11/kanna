import { LOG_PREFIX } from "../shared/branding"

interface DeferredRestartControllerOptions {
  isIdle: () => boolean
  restart: () => void
  log?: (message: string) => void
  intervalMs?: number
  idleGraceMs?: number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export function createDeferredRestartController(options: DeferredRestartControllerOptions) {
  const log = options.log ?? console.log
  const intervalMs = options.intervalMs ?? 1000
  const idleGraceMs = options.idleGraceMs ?? 2 * 60 * 1000
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

  function scheduleIdleGrace() {
    if (idleGraceTimeout) return
    idleGraceTimeout = setTimeoutFn(() => {
      idleGraceTimeout = null
      if (!restartRequested || !options.isIdle()) return
      restartRequested = false
      restartNow("deferred restart idle grace period elapsed")
    }, idleGraceMs)
  }

  function checkRestartConditions() {
    if (!restartRequested) {
      cancelIdleGrace()
      return
    }

    if (!options.isIdle()) {
      cancelIdleGrace()
      return
    }

    scheduleIdleGrace()
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
