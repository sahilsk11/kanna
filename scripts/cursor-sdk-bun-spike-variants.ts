/**
 * Spike variants: stream vs wait-only vs onDelta under Bun.
 */
import { Agent, CursorAgentError } from "@cursor/sdk"

const apiKey = process.env.CURSOR_API_KEY?.trim()
if (!apiKey) {
  console.error("FAIL: CURSOR_API_KEY is not set")
  process.exit(1)
}

async function runVariant(name: string, fn: () => Promise<void>) {
  console.log(`\n=== ${name} ===`)
  try {
    await fn()
    console.log(`${name}: PASS`)
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`${name}: CursorAgentError`, err.message)
    } else {
      console.error(`${name}:`, err)
    }
  }
}

await runVariant("wait_only", async () => {
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd(), settingSources: [] },
  })
  try {
    const run = await agent.send("Reply with exactly: BUN_WAIT_ONLY_OK")
    const result = await run.wait()
    console.log("status", result.status, "text_preview", String(result.result ?? "").slice(0, 120))
    if (result.status !== "finished") throw new Error(`unexpected status ${result.status}`)
  } finally {
    await agent.close()
  }
})

await runVariant("on_delta", async () => {
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd(), settingSources: [] },
  })
  try {
    let deltaCount = 0
    const run = await agent.send("Reply with exactly: BUN_ON_DELTA_OK", {
      onDelta: () => {
        deltaCount += 1
      },
    })
    const result = await run.wait()
    console.log("status", result.status, "deltaCount", deltaCount)
    if (result.status !== "finished") throw new Error(`unexpected status ${result.status}`)
  } finally {
    await agent.close()
  }
})

await runVariant("agent_prompt", async () => {
  const result = await Agent.prompt("Reply with exactly: BUN_PROMPT_OK", {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd(), settingSources: [] },
  })
  console.log("status", result.status, "text_preview", String(result.result ?? "").slice(0, 120))
  if (result.status !== "finished") throw new Error(`unexpected status ${result.status}`)
})
