# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (embedded Electron surface, one turn at a time)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
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
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call is bound to one outer Codex turn capability.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and one visible browser surface.
Playwright attaches to that exact surface through a launcher-owned loopback CDP endpoint; it does
not launch another browser or copy authentication state. A Codex turn navigates the owned surface
to a fresh Temporary Chat, and the surface returns to an inert local page after completion. The
login persists locally while browser conversations are not reused between tasks.

The complete serialized Codex task is inserted as one inline JSON envelope. Image bytes stay out of
the JSON and are attached natively with stable references. The runtime does not create a context
JSONL file, upload a synthetic context document, include prompt hashes, or truncate the envelope.
Attachment acceptance and send readiness are verified before the turn begins.

ChatGPT owns context compaction inside that browser response. The appended models intentionally
advertise no Codex context window or auto-compaction threshold, and routed compaction v1/v2 calls
fail explicitly instead of opening a second summarizer turn. A prompt-level checkpoint marker is
translated into a visible Codex trace item; tool-capable turns re-bind the same capability after
that checkpoint. Visible ChatGPT status rows become reasoning summaries, while stable prose between
rows becomes native Codex commentary.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no system Node/Bun. Full mode separately
downloads the official pinned `openai/tunnel-client` build for the current OS/architecture and
verifies it against the release SHA-256 manifest.

On first launch, the embedded runtime is identity-checked and copied atomically into a private
versioned directory under the application home. Daemon and MCP commands use that durable copy,
which is required because Linux AppImage mount paths are temporary and must never be persisted in
Codex or tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the optional
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Native login items or an owner-local XDG autostart file launch the app
hidden after sign-in. A marker containing only launcher-owned PIDs lets doctor distinguish the
launcher runtime from a stale or external process. Legacy macOS launchd services are drained and
removed during an explicit launcher migration; launchd remains only for the advanced terminal-only
mode.

Setup switches `openai_base_url` and installs one managed provider, `codex-chatgpt-web`, that is
identical to Codex's built-in `openai` provider except for `base_url` and
`supports_websockets = false`. Codex's built-in providers are not overridable — a user-supplied
`[model_providers.openai]` table is discarded by `merge_configured_model_providers` — so pinning
the transport requires a separate provider id plus the top-level `model_provider` assignment. Both
are recorded in the integration journal and reversed by uninstall. The daemon forwards the
authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed.

The managed provider never negotiates a Responses WebSocket, so the loopback route is reached over
HTTP/SSE on the first attempt. `GET /v1/responses` still returns HTTP `426` as a defensive signal
for any client that tries to upgrade. Without the provider, Codex opens a WebSocket against the
loopback route on every turn and spends its entire `stream_max_retries` budget — the visible
`Reconnecting 1/5 … 5/5` banner — before falling back to HTTP. No model or provider fallback
occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses HTTP requests, including native compaction passthrough;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. The launcher then stops the
tunnel through its runtime command and asks the daemon to flush state and exit through an
authenticated shutdown endpoint. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible. An
unexpected child exit is recovered with a bounded restart budget; a crash loop becomes an explicit
launcher error.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Serialize browser turns and reject unsupported models explicitly. The selected routed model fixes
  the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
