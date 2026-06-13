/**
 * Test whether Bun can use run.stream() if errors are caught, or must avoid stream().
 */
import { Agent } from "@cursor/sdk"

const apiKey = process.env.CURSOR_API_KEY!.trim()

async function testCaughtStream() {
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd(), settingSources: [] },
  })
  try {
    const run = await agent.send("Reply with exactly: BUN_CAUGHT_STREAM_OK")
    let events = 0
    try {
      for await (const event of run.stream()) {
        events += 1
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") {
              console.log("assistant", block.text.slice(0, 80))
            }
          }
        }
      }
      console.log("stream_completed_normally", events)
    } catch (streamErr) {
      console.log("stream_caught_error", streamErr instanceof Error ? streamErr.message : String(streamErr))
    }
    const result = await run.wait()
    console.log("wait_after_caught_stream", { events, status: result.status, text: result.result })
  } finally {
    await agent.close()
  }
}

async function testResume() {
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd(), settingSources: [] },
  })
  const agentId = agent.agentId
  const run1 = await agent.send("Remember the code word SPIKE42. Reply with exactly: REMEMBERED")
  const result1 = await run1.wait()
  await agent.close()
  console.log("first_turn", { agentId, status: result1.status })

  const resumed = await Agent.resume(agentId, { apiKey, model: { id: "composer-2.5" }, local: { cwd: process.cwd() } })
  const run2 = await resumed.send("What was the code word? Reply with one word only.")
  const result2 = await run2.wait()
  await resumed.close()
  console.log("resume_turn", { status: result2.status, text: String(result2.result ?? "").slice(0, 80) })
}

console.log("--- caught_stream ---")
await testCaughtStream()
console.log("--- resume ---")
await testResume()
