import { describe, expect, test } from "bun:test"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_DEFERRED_RESTART_SIGNAL,
  CLI_STARTUP_UPDATE_RESTART_EXIT_CODE,
  CLI_UI_UPDATE_RESTART_EXIT_CODE,
  isUiUpdateRestart,
  parseChildArgsEnv,
  shouldRestartCliProcess,
} from "./restart"
import { createDeferredRestartController } from "./deferred-restart"

describe("shouldRestartCliProcess", () => {
  test("restarts only for the sentinel exit code without a signal", () => {
    expect(shouldRestartCliProcess(CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, null)).toBe(true)
    expect(shouldRestartCliProcess(CLI_UI_UPDATE_RESTART_EXIT_CODE, null)).toBe(true)
    expect(shouldRestartCliProcess(0, null)).toBe(false)
    expect(shouldRestartCliProcess(1, null)).toBe(false)
    expect(shouldRestartCliProcess(CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, "SIGTERM")).toBe(false)
    expect(CLI_DEFERRED_RESTART_SIGNAL).toBe("SIGUSR2")
    expect(isUiUpdateRestart(CLI_UI_UPDATE_RESTART_EXIT_CODE, null)).toBe(true)
    expect(isUiUpdateRestart(CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, null)).toBe(false)
  })

  test("parses configured child args from the environment", () => {
    expect(parseChildArgsEnv(undefined)).toEqual([])
    expect(parseChildArgsEnv("[\"run\",\"./scripts/dev-server.ts\"]")).toEqual(["run", "./scripts/dev-server.ts"])
    expect(() => parseChildArgsEnv("{\"bad\":true}")).toThrow(`Invalid ${CLI_CHILD_ARGS_ENV_VAR}`)
  })
})

describe("createDeferredRestartController", () => {
  test("restarts after the idle grace period when the server is idle", () => {
    const messages: string[] = []
    let restarts = 0
    const timeoutCallback: { current: (() => void) | null } = { current: null }
    const controller = createDeferredRestartController({
      isIdle: () => true,
      restart: () => {
        restarts++
      },
      log: (message) => messages.push(message),
      idleGraceMs: 120_000,
      setTimeoutFn: ((callback: () => void, delay?: number) => {
        expect(delay).toBe(120_000)
        timeoutCallback.current = callback
        return 1
      }) as typeof setTimeout,
    })

    controller.request("reload requested")

    expect(restarts).toBe(0)
    expect(controller.pending).toBe(true)
    expect(messages).toContain("[kanna] reload requested, deferring restart until active sessions are idle")

    timeoutCallback.current?.()

    expect(restarts).toBe(1)
    expect(controller.pending).toBe(false)
    expect(messages).toContain("[kanna] deferred restart idle grace period elapsed, restarting now")
  })

  test("defers restart until the server remains idle for the grace period", () => {
    const messages: string[] = []
    let restarts = 0
    let idle = false
    const intervalCallback: { current: (() => void) | null } = { current: null }
    const timeoutCallback: { current: (() => void) | null } = { current: null }
    let intervalCleared = false

    const controller = createDeferredRestartController({
      isIdle: () => idle,
      restart: () => {
        restarts++
      },
      log: (message) => messages.push(message),
      setIntervalFn: ((callback: () => void) => {
        intervalCallback.current = callback
        return 1
      }) as typeof setInterval,
      clearIntervalFn: (() => {
        intervalCleared = true
      }) as typeof clearInterval,
      setTimeoutFn: ((callback: () => void) => {
        timeoutCallback.current = callback
        return 2
      }) as typeof setTimeout,
    })

    controller.request("reload requested")

    expect(restarts).toBe(0)
    expect(controller.pending).toBe(true)
    expect(messages).toContain("[kanna] reload requested, deferring restart until active sessions are idle")

    expect(intervalCallback.current).not.toBeNull()
    intervalCallback.current?.()
    expect(restarts).toBe(0)

    idle = true
    intervalCallback.current?.()

    expect(restarts).toBe(0)
    expect(controller.pending).toBe(true)
    expect(timeoutCallback.current).not.toBeNull()

    timeoutCallback.current?.()

    expect(restarts).toBe(1)
    expect(controller.pending).toBe(false)
    expect(intervalCleared).toBe(true)
    expect(messages).toContain("[kanna] deferred restart idle grace period elapsed, restarting now")
  })

  test("cancels the idle grace period when activity resumes", () => {
    let restarts = 0
    let idle = true
    const intervalCallback: { current: (() => void) | null } = { current: null }
    const timeoutCallbacks: Array<() => void> = []
    let timeoutsCleared = 0

    const controller = createDeferredRestartController({
      isIdle: () => idle,
      restart: () => {
        restarts++
      },
      log: () => {},
      idleGraceMs: 120_000,
      setIntervalFn: ((callback: () => void) => {
        intervalCallback.current = callback
        return 1
      }) as typeof setInterval,
      setTimeoutFn: ((callback: () => void) => {
        timeoutCallbacks.push(callback)
        return timeoutCallbacks.length
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {
        timeoutsCleared++
      }) as typeof clearTimeout,
    })

    controller.request("reload requested")

    expect(timeoutCallbacks).toHaveLength(1)

    idle = false
    intervalCallback.current?.()

    expect(timeoutsCleared).toBe(1)

    timeoutCallbacks[0]?.()
    expect(restarts).toBe(0)
    expect(controller.pending).toBe(true)

    idle = true
    intervalCallback.current?.()

    expect(timeoutCallbacks).toHaveLength(2)
    timeoutCallbacks[1]?.()

    expect(restarts).toBe(1)
    expect(controller.pending).toBe(false)
  })
})
