/**
 * Spike: verify @cursor/sdk works under Bun (import, create, send, stream, wait, dispose).
 * Usage: CURSOR_API_KEY=... bun run scripts/cursor-sdk-bun-spike.ts
 */
import { Agent, CursorAgentError } from "@cursor/sdk"

const apiKey = process.env.CURSOR_API_KEY?.trim()
if (!apiKey) {
  console.error("FAIL: CURSOR_API_KEY is not set")
  process.exit(1)
}

const cwd = process.cwd()
const stages: string[] = []

function stage(name: string) {
  stages.push(name)
  console.log(`[spike] ${name}`)
}

async function main() {
  stage("import_ok")

  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null
  try {
    stage("agent_create_begin")
    agent = await Agent.create({
      apiKey,
      model: { id: "composer-2.5" },
      local: { cwd, settingSources: [] },
    })
    stage(`agent_create_ok agentId=${agent.agentId}`)

    stage("agent_send_begin")
    const run = await agent.send("Reply with exactly: BUN_SDK_SPIKE_OK")
    stage(`agent_send_ok runId=${run.id}`)

    let sawAssistant = false
    stage("run_stream_begin")
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            sawAssistant = true
            console.log(`[spike] assistant_chunk=${JSON.stringify(block.text.slice(0, 120))}`)
          }
        }
      }
    }
    stage(`run_stream_ok sawAssistant=${sawAssistant}`)

    stage("run_wait_begin")
    const result = await run.wait()
    stage(`run_wait_ok status=${result.status}`)

    if (result.status === "error") {
      console.error("FAIL: run finished with error status")
      process.exit(2)
    }

    stage("agent_close_begin")
    await agent.close()
    agent = null
    stage("agent_close_ok")

    console.log("\nSPIKE_RESULT: PASS")
    console.log(JSON.stringify({ stages, status: result.status }, null, 2))
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error("FAIL: CursorAgentError", {
        message: err.message,
        isRetryable: err.isRetryable,
        code: (err as { code?: string }).code,
      })
    } else {
      console.error("FAIL:", err)
    }
    process.exit(1)
  } finally {
    if (agent) {
      try {
        await agent.close()
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

main()
