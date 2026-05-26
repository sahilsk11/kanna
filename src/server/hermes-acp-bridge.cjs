#!/usr/bin/env node

const { spawn } = require("node:child_process")

const child = spawn("hermes", ["acp"], {
  cwd: process.cwd(),
  env: process.env,
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
