# Hermes Harness Phased Implementation Plan

Ticket: SAS-43
Research: `/home/sahil/artifacts/kanna-hermes-harness/eng-research-2026-05-26.md`

## Guardrails

- Work only in `/home/sahil/wt/kanna-sas-43-hermes-harness`.
- Preserve the dirty primary checkout at `/home/sahil/projects/kanna`.
- Keep Claude and Codex behavior stable.
- Prefer a Hermes-specific ACP manager for v1; keep it extractable into a generic ACP manager later.
- Use Hermes' configured default provider/model in v1 unless model state mapping is cheap and safe.

## Phase 1: Provider Types, Catalog, Settings, And Preferences

Status: DONE

Validation:

- `bunx tsc --noEmit`
- `bun test src/shared/types.test.ts src/server/provider-catalog.test.ts src/server/app-settings.test.ts src/client/stores/chatPreferencesStore.test.ts src/client/stores/appSettingsStore.test.ts src/client/components/chat-ui/ChatInput.test.ts src/client/components/chat-ui/ChatPreferenceControls.test.tsx src/server/ws-router.test.ts`

Notes:

- Hermes uses `hermes-configured-default` with empty model options and `supportsPlanMode: false` for v1.
- TypeScript required adjacent control/ws-router updates so Hermes does not fall through Codex fast-mode/model-option paths.

Extend shared provider modeling to include `hermes`.

Expected areas:

- `src/shared/types.ts`
- `src/server/provider-catalog.ts`
- `src/server/app-settings.ts`
- `src/client/stores/chatPreferencesStore.ts`
- `src/client/stores/appSettingsStore.ts`
- relevant tests

Work:

- Add Hermes provider option, default model placeholder, and minimal model options.
- Normalize `defaultProvider` and provider defaults for Hermes.
- Update persisted composer/preference state types and migration paths.
- Update generic provider helpers so adding Hermes does not route through Codex branches accidentally.
- Add focused tests for Hermes defaults and existing Claude/Codex preservation.

## Phase 2: Hermes ACP Protocol And Manager

Status: DONE

Validation:

- `bun test src/server/hermes-acp.test.ts`
- `bunx tsc --noEmit`

Notes:

- `session/prompt` is a long-running ACP request; `HermesAcpManager.startTurn` streams `session/update` notifications while resolving the prompt response in the background.
- ACP `session/request_permission` is conservatively auto-denied for v1 so Hermes does not hang while Kanna permission UI mapping is deferred.
- ACP `session/resume` does not return a session id, so the manager preserves Kanna's stored Hermes session token after resume.
- `generateStructured` is implemented with a transient Hermes ACP session for possible future quick-response fallback use.

Add a server-side Hermes ACP adapter that implements Kanna's harness boundary.

Expected areas:

- new `src/server/hermes-acp-protocol.ts`
- new `src/server/hermes-acp.ts`
- focused adapter tests

Work:

- Spawn `hermes acp` with stdio pipes.
- Implement JSON-RPC request/response handling and stderr failure reporting.
- Implement session create/load/resume/fork/list/cancel/prompt enough for Kanna turns.
- Map ACP `session/update` notifications into `HarnessEvent` transcript entries:
  - system init
  - assistant text chunks
  - thought/reasoning chunks
  - tool start/tool complete
  - plan/todo updates
  - usage/context updates where available
  - result/final status
- Implement `interrupt` through ACP cancel.
- Add unit tests with a fake ACP process.

## Phase 3: Coordinator Routing, Session Tokens, And Discovery

Status: DONE

Validation:

- `bun test src/server/agent.test.ts`
- `bun test src/server/discovery.test.ts`
- `bun test src/server/ws-router.test.ts`
- `bun test src/server/read-models.test.ts`
- `bunx tsc --noEmit`

Notes:

- Hermes coordinator routing is explicit and keeps Hermes sends off Codex manager paths.
- Hermes discovery uses direct SQLite reads from `~/.hermes/state.db`, scoped to ACP sessions with `source = 'acp'` and an absolute `cwd` in `model_config`.

Wire Hermes into Kanna's server workflow.

Expected areas:

- `src/server/agent.ts`
- `src/server/discovery.ts`
- `src/server/read-models.ts`
- `src/server/ws-router.ts`
- relevant tests

Work:

- Inject and instantiate `HermesAcpManager`.
- Replace Claude-vs-Codex implicit branching with explicit provider routing.
- Start Hermes sessions with the current project cwd and stored session token.
- Clear pending fork token after successful Hermes fork.
- Ensure cancel/close/stopAll clean up Hermes processes.
- Add Hermes project/session discovery, preferring ACP/list where feasible or SQLite read as a scoped fallback.
- Add routing tests proving Hermes does not hit Codex manager paths.

## Phase 4: Client Controls And Rendering

Status: DONE

Validation:

- `bun test src/client/components/chat-ui/ChatPreferenceControls.test.tsx src/client/stores/chatPreferencesStore.test.ts src/client/stores/appSettingsStore.test.ts`
- `bunx tsc --noEmit`

Notes:

- Hermes is visible in provider defaults and the provider picker but hides Claude/Codex-only controls.
- Local project empty-state copy now includes Hermes.

Expose Hermes in the UI without overbuilding provider-specific controls.

Expected areas:

- `src/client/components/chat-ui/ChatPreferenceControls.tsx`
- `src/client/components/chat-ui/ChatInput.tsx`
- `src/client/app/SettingsPage.tsx`
- message rendering tests if needed

Work:

- Add Hermes icon/label handling.
- Hide Codex-only fast mode and Claude-only context controls for Hermes.
- Display minimal Hermes defaults in Settings.
- Ensure provider picker, chat composer, and locked-provider behavior work for Hermes.
- Keep button/control layout stable across desktop and mobile.

## Phase 5: Verification And Preview

Status: DONE

Validation:

- `bun test src/shared/types.test.ts src/server/provider-catalog.test.ts src/server/app-settings.test.ts src/server/hermes-acp.test.ts src/server/agent.test.ts src/server/discovery.test.ts src/server/ws-router.test.ts src/server/read-models.test.ts src/client/app/SettingsPage.test.tsx src/client/stores/chatPreferencesStore.test.ts src/client/stores/appSettingsStore.test.ts src/client/components/chat-ui/ChatInput.test.ts src/client/components/chat-ui/ChatPreferenceControls.test.tsx`
- `bun run check`
- `bun -e 'import { HermesAcpManager } from "./src/server/hermes-acp.ts"; const m = new HermesAcpManager(); const id = await m.startSession({ chatId: "bridge-smoke", cwd: process.cwd(), sessionToken: null }); console.log(id); m.stopAll();'`

Browser verification:

- Local app: `http://127.0.0.1:5174/`
- Desktop viewport: `1440x1000`
- Mobile viewport: `390x844`
- Verified Providers settings show Hermes defaults.
- Verified chat provider picker includes Hermes.
- Verified a Hermes chat completes through real `hermes acp` and returns `hello from Hermes`.
- Verified locked Hermes chat displays `Configured Default`, not Codex defaults.
- Console/page errors: none beyond expected Vite/React development messages.

Preview:

- `https://pv-0fb05c.ultron.sh`
- Expires in 24 hours.
- Smoke test returned the expected Cloudflare Access `302`.

Run focused and full checks, then verify real behavior.

Work:

- Run unit tests for touched server/client modules.
- Run TypeScript/build checks.
- Start Kanna dev server from the worktree.
- Use Agent Browser to verify:
  - Hermes appears in provider picker.
  - A new chat can select Hermes.
  - A safe Hermes prompt completes.
  - No critical console/page errors.
- Expose a preview URL with `ultron expose` only after local browser verification passes.

## Final Verification

Status: DONE

Residual risks:

- The Hermes manager uses a Node stdio bridge because Bun can spawn `hermes acp` but does not receive stdout from that Python ACP process in this environment. The bridge was verified with a live session start and real Kanna chat prompt.
- Hermes permission requests are auto-denied in v1; richer Kanna permission UI mapping is intentionally deferred.

Record commands, browser checks, preview URL, and any residual risks here after implementation.
