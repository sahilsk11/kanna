# PR 2 Plan: Provider Plumbing Cleanup

## Goal

Make the server-side provider orchestration easier to extend before adding Cursor back.

This PR should preserve current behavior for Claude, Codex, and OpenCode. It should not add Cursor, introduce a new SDK, change UI, or alter provider runtime semantics.

## Current Shape

The main coordination point is `src/server/agent.ts`.

`AgentCoordinator` currently owns both the provider-independent chat lifecycle and provider-specific startup details:

- resolving provider settings
- appending the user prompt
- recording turn start/finish/failure
- creating or resuming provider sessions
- starting provider turns
- tracking active turns and pending tool requests
- closing sessions
- deciding fork support

The most important cleanup target is `startTurnForChat`, where shared orchestration and provider-specific branching are mixed together.

## Non-Goals

- Do not add Cursor.
- Do not add `@cursor/sdk`.
- Do not rewrite Claude, Codex, or OpenCode managers.
- Do not change transcript formats.
- Do not change persistence formats.
- Do not refactor client UI.
- Do not move code into a broad abstraction unless it directly reduces the next Cursor diff.

## Proposed Diff

### 1. Add Exhaustiveness Helpers

Add a small `assertNever` helper near the provider utilities:

```ts
function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`)
}
```

Use this in provider `switch` statements so future providers cannot fall through implicitly.

### 2. Extract Provider Settings Resolution

Replace `getProviderSettings`'s implicit fallback logic with explicit provider helpers:

```ts
private getClaudeProviderSettings(options: SendMessageOptions): ProviderSettings
private getCodexProviderSettings(options: SendMessageOptions): ProviderSettings
private getOpenCodeProviderSettings(options: SendMessageOptions): ProviderSettings
```

Then make `getProviderSettings` an exhaustive switch:

```ts
switch (provider) {
  case "claude":
    return this.getClaudeProviderSettings(options)
  case "codex":
    return this.getCodexProviderSettings(options)
  case "opencode":
    return this.getOpenCodeProviderSettings(options)
  default:
    return assertNever(provider)
}
```

This removes the current "anything not Claude/OpenCode is Codex" assumption.

### 3. Extract Provider Turn Startup

Split the provider-specific portion of `startTurnForChat` into provider-specific helpers:

```ts
private async startClaudeProviderTurn(args: ProviderTurnStartArgs): Promise<HarnessTurn>
private async startCodexProviderTurn(args: ProviderTurnStartArgs): Promise<HarnessTurn>
private async startOpenCodeProviderTurn(args: ProviderTurnStartArgs): Promise<HarnessTurn>
```

Each helper should own only provider startup:

- provider boot logging
- session start/resume
- pending fork token clearing when applicable
- manager `startTurn`
- provider-specific prompt construction

`startTurnForChat` should remain the owner of shared orchestration:

- draining stream cleanup
- active turn guard
- chat provider assignment
- plan mode persistence
- title generation setup
- user prompt append
- `recordTurnStarted`
- `onToolRequest`
- `ActiveTurn` creation

### 4. Centralize Provider Capabilities

Add a local provider capabilities table near the provider helpers:

```ts
const SERVER_PROVIDER_CAPABILITIES = {
  claude: {
    canFork: true,
    supportsPlanMode: true,
  },
  codex: {
    canFork: true,
    supportsPlanMode: true,
  },
  opencode: {
    canFork: false,
    supportsPlanMode: false,
  },
} as const satisfies Record<AgentProvider, {
  canFork: boolean
  supportsPlanMode: boolean
}>
```

Use this for fork restrictions and, where sensible, plan-mode gating.

Keep model catalog behavior intact. If `getServerProviderCatalog(provider).supportsPlanMode` remains the source of truth for UI/catalog behavior, the new table can be limited to server behavior such as fork support.

### 5. Make Close/Stop Paths Explicit

Keep `closeChat` and `stopAll` behavior unchanged, but make provider cleanup easy to extend:

```ts
private stopProviderSession(provider: AgentProvider, chatId: string): void
private stopAllProviderSessions(): void
```

For now:

- Claude is still managed through `claudeSessions`.
- Codex uses `codexManager.stopAll()`.
- OpenCode uses `opencodeManager.stopSession(chatId)` and `opencodeManager.stopAll()`.

Do not invent per-provider session maps for providers that do not need them.

## Suggested Review Order

1. Add types/helpers only.
2. Extract provider settings helpers and tests.
3. Extract provider turn startup helpers.
4. Centralize fork/capability checks.
5. Run focused tests.

Keep commits small if this becomes more than one logical diff.

## Tests

Run the focused server tests that exercise provider orchestration:

```sh
bun test src/server/agent.test.ts src/server/provider-catalog.test.ts src/shared/types.test.ts
```

If provider settings tests live elsewhere after the Hermes removal, include those too:

```sh
bun test src/server/app-settings.test.ts src/client/stores/chatPreferencesStore.test.ts
```

Expected result: behavior should be unchanged. Any snapshot or assertion changes should be explainable as naming/extraction only, not runtime behavior.

## Acceptance Criteria

- `startTurnForChat` reads as provider-independent orchestration.
- Provider startup details live in explicit Claude/Codex/OpenCode helper methods.
- Provider settings resolution is exhaustive and has no fallback provider assumption.
- Fork restrictions are not hard-coded inline in multiple places.
- No Cursor references are added.
- Existing Claude, Codex, and OpenCode tests pass.

## Why This Helps Cursor

The next Cursor PR should be able to add a `CursorSdkManager` and then wire it through a small number of obvious places:

- provider settings switch
- provider startup switch
- close/stop helpers
- capabilities table
- tests

That keeps the Cursor runtime PR focused on Cursor behavior instead of mixing it with a cleanup of existing provider orchestration.
