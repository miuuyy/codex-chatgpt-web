# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
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
- The fixed models send the complete Codex context and image attachments to a fresh ChatGPT
  Temporary Chat. Registered Project-conversation models send only the latest capsule/delta and its
  images to their exact saved URL.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same fixed models; Instant through Extra High are tool-capable, while Pro remains
  read-only.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call is bound to one outer Codex turn capability.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each Codex task is leased an independent `WebContentsView` and surface ID; Playwright attaches
to that exact surface through a launcher-owned loopback CDP endpoint. It does not launch another
browser or copy authentication state. Fixed models open a fresh Temporary Chat. A registered
Project-conversation model navigates directly to its owner-local opaque canonical URL and verifies
the visible Project and conversation labels. Tabs share only the local login partition and keep
their own document and lifecycle. Completed tabs remain inspectable until
closed. Closing a running tab destroys its page and terminates that browser turn. A sixth concurrent
turn fails explicitly; the cap avoids excessive parallel traffic that could trigger account abuse
controls.

The complete serialized Codex task is inserted as one inline JSON envelope. Image bytes stay out of
the JSON and are attached natively with stable references. The runtime does not create a context
JSONL file, upload a synthetic context document, include prompt hashes, or truncate the envelope.
Attachment acceptance and send readiness are verified before the turn begins.

Persistent routes are explicit Pro-only models under `chatgpt-web/project/<route-key>`. A per-URL
FIFO mutex prevents overlapping sends even if the same URL was accidentally presented by multiple
callers. The browser snapshots the ordered `data-testid` identity of every existing assistant turn
before sending, then accepts exactly one new identity after the unchanged prefix. It reads and
returns only that completed turn. Route, label, or identity drift fails closed; no retry, fallback,
replacement tab, Project, or conversation is created. These routes reject compaction turns and
compile only the latest user capsule/delta, leaving prior context to the existing ChatGPT Project
conversation.

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

Setup keeps Codex's built-in `openai` provider and switches only `openai_base_url`. The daemon
forwards the authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

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
- Limit browser turns to five task-bound tabs; additionally serialize every registered persistent
  destination. Reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
