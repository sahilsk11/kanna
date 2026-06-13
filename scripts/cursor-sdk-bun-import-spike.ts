/** Import-only spike: does @cursor/sdk load under Bun without hitting the network? */
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk"

console.log("import_ok", {
  hasAgentCreate: typeof Agent.create === "function",
  hasAgentPrompt: typeof Agent.prompt === "function",
  hasAgentResume: typeof Agent.resume === "function",
  hasModelsList: typeof Cursor.models.list === "function",
  hasCursorAgentError: typeof CursorAgentError === "function",
})
