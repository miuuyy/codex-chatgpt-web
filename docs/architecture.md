# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (one Chromium or Firefox process, one turn at a time)
  ├─ capability broker (full mode only)
  └─ MCP server (stdio or Streamable HTTP)
            ▲
            │ outbound OpenAI Tunnel or ngrok
            ▼
      ChatGPT custom connector
```

## Modes

### `browser-only`

- Exposes Instant (`chatgpt-web/light`), Medium, High, and Extra High; each model advertises exactly one
  immutable Codex effort matching its ChatGPT browser mode. `chatgpt-web/pro` is appended only when
  the authenticated account exposes Pro.
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same fixed models; Instant through Extra High are tool-capable, while Pro remains
  read-only.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client` or a stable ngrok endpoint.
- Every connector call is bound to one outer Codex turn capability.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

## Browser lifecycle

The daemon owns one long-lived Chromium or Firefox process. Firefox uses Playwright's compatible
managed browser build. A Codex turn gets a fresh Temporary Chat page; the preceding page is
closed. This prevents transcript leakage without creating a new Chrome window per tool call.

Contexts through 40,000 serialized characters remain an inline JSON envelope. Larger contexts
become one in-memory JSONL attachment with a manifest, ordered system/message records, and image
references. Nothing is written to a temporary context file, and the complete attachment remains
included in conservative usage accounting. File acceptance and send readiness are verified before
the turn begins.

ChatGPT owns context compaction inside that browser response. The appended models intentionally
advertise no Codex context window or auto-compaction threshold, and routed compaction v1/v2 calls
fail explicitly instead of opening a second summarizer turn. A prompt-level checkpoint marker is
translated into a visible Codex trace item; tool-capable turns re-bind the same capability after
that checkpoint. Visible ChatGPT status rows become reasoning summaries, while stable prose between
rows becomes native Codex commentary.

## Installation and service lifecycle

The release artifact is a versioned runtime bundle containing a pinned Bun executable and the
bundled application. It contains the Responses bridge, Playwright client code, MCP server, setup,
doctor, and launchd/systemd management. Chromium uses the user's configured executable; Firefox is
installed by Playwright during setup. OpenAI full mode separately downloads the official pinned
`openai/tunnel-client` release and verifies it against that release's published SHA-256 manifest.

Setup creates a launchd service on macOS or a systemd user service on Linux for the Responses proxy.
Full mode creates a second managed service. It runs `tunnel-client` directly, or runs an ngrok
process beside a loopback Streamable HTTP MCP server. No shell, terminal, tmux session, or manual
post-login command owns production
lifecycle. Setup keeps Codex's built-in `openai` provider and switches only `openai_base_url` after
required services report healthy and ready. The daemon forwards the authenticated official model
catalog and appends only the routed models owned by the `chatgpt-web/` namespace; no static catalog
is installed.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses HTTP requests, including native compaction passthrough;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. If the contract is unavailable,
malformed, or non-idle, the operation fails closed and resumes the old daemon when possible.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Serialize browser turns and reject unsupported models explicitly. The selected routed model fixes
  the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
