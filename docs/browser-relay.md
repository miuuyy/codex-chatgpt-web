# Browser Relay (experimental)

Browser Relay is an optional alternative to the full MCP harness when a ChatGPT
connector or tunnel is unavailable. The **Codex client still owns local tool
execution**. ChatGPT Web returns one structured decision, and the bridge
translates it into native Responses API tool-call output. Codex applies its
normal sandbox and approval flow before running the tool. This is independent
of the ChatGPT plugin/MCP SSE connection.

This mode uses the project's ordinary automatic ChatGPT browser session; it is
not a new browser extension and requires no extra local command executor.

## Enable

On a source checkout of this fork with Bun 1.4.0 installed:

```powershell
bun install --frozen-lockfile
bun run src/cli.ts setup --browser-only --browser-relay --acknowledge-unofficial
```

Complete the ordinary setup and Codex model integration for the source build.
Use the resulting `chatgpt-web/*` model within the Codex CLI or IDE. A
ChatGPT plugin is **not** required for Browser Relay. If switching from
full-harness mode, the setup command explicitly changes to browser-only mode.

To switch back to standard browser-only behavior, run:

```powershell
bun run src/cli.ts setup --browser-only --no-browser-relay --acknowledge-unofficial
```

The feature is off by default and cannot be combined with full MCP harness
or manual Zero Risk browser interaction. No silent automatic fallback is
performed after partial MCP tool execution.

## Protocol

The bridge sends the current Codex tool catalog and tool-selection constraints
as part of the browser prompt. ChatGPT Web must return exactly one JSON value:

```json
{"protocol":"codex-browser-relay/v1","type":"tool_calls","calls":[{"name":"exec_command","arguments":{"cmd":"pwd"}}]}
```

The tool name and arguments above are illustrative; the names and schemas
**must** match the tools actually supplied by that specific Codex request.
Freeform tools use an `{"input":"..."}` argument. The bridge validates the
complete response before emitting any native tool call, including maximum batch
size, tool availability, argument schemas, tool choice and parallel-call rules.
Codex runs the tool and sends its actual result in the next Responses round.

For a final answer:

```json
{"protocol":"codex-browser-relay/v1","type":"final","answer":"Work completed."}
```

The JSON envelope is unwrapped before being returned to the Codex user. Invalid
or incomplete JSON is rejected without executing tools. Calls receive stable IDs
for the same response, supporting normal Codex response replay. A browser
regeneration with different content is not guaranteed to be idempotent; normal
Codex sandbox and approvals remain essential.

## Verification

Run the focused suite, type checks and the full project verification on the
source checkout:

```powershell
bun test ./tests/browser-relay.test.ts
bun run typecheck
bun run verify
```

The focused suite verifies JSON parsing and failure handling, tool constraints,
namespace/freeform handling, native Responses SSE translation, stable call IDs
and tool results in subsequent prompt context. Additional manual acceptance
testing requires a logged-in browser session and an active Codex client:

1. Select a `chatgpt-web/*` model with Browser Relay enabled.
2. Request a read-only local command and confirm the Codex tool result appears
   in the next model round.
3. Request an edit in a disposable test checkout and verify the native Codex
   sandbox or approval prompt appears as expected.
4. Cancel during a tool call, retry the same turn, and verify no duplicate
   filesystem mutation occurs.
5. Confirm a final answer is rendered without the protocol JSON envelope.

## Limitations

Browser Relay relies on structured **text** emitted by the ChatGPT Web UI, not
a native tool-calling API. The web UI may change, truncate an answer or return
invalid JSON. A schema error fails the request; it cannot be treated as a tool
execution success. This transport avoids MCP SSE errors but does not bypass
ChatGPT Web availability or usage limits, and cannot guarantee uninterrupted
operation. The source branch must pass its automated CI and Windows/browser
acceptance checks before production use.
