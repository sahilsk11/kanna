#!/usr/bin/env node

const { spawn } = require("node:child_process")

const profile = (process.env.KANNA_HERMES_PROFILE || "").trim()
const args = profile ? ["-p", profile, "acp"] : ["acp"]
const env = {
  ...process.env,
  ...(profile === "stormbreaker" ? {
    HERMES_LIGHT: process.env.HERMES_LIGHT || "0",
    HERMES_TUI_THEME: process.env.HERMES_TUI_THEME || "dark",
  } : {}),
}

const child = spawn("hermes", args, {
  cwd: process.cwd(),
  env,
  stdio: ["pipe", "pipe", "pipe"],
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

const stop = (signal) => {
  if (!child.killed) {
    child.kill(signal)
  }
}

process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))

child.on("error", (error) => {
  console.error(error?.message ?? String(error))
  process.exitCode = 1
})

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? process.exitCode ?? 0)
})
