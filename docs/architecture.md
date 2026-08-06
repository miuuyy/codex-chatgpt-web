# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (independent task-bound Electron tabs)
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

The desktop launcher owns one persistent Electron partition and independently task-bound browser
tabs with no fixed application-level maximum. Each Codex task is leased an independent
`WebContentsView` and surface ID; Playwright attaches
to that exact surface through a launcher-owned loopback CDP endpoint. It does not launch another
browser or copy authentication state. Each tab opens a fresh Temporary Chat, shares only the local
login partition, and keeps its own document and lifecycle. Completed tabs remain inspectable until
closed. Closing a running tab destroys its page and terminates that browser turn. The application
does not reject additional tabs based on their count; available machine resources and ChatGPT
account-side controls remain the practical boundaries.

Every routed turn uploads exactly one task-context document containing the complete sanitized
`<codex_context_json>` envelope. Normal, read-only, and tool-capable turns attach it as a plain
UTF-8 text document named `codex-task-context.txt`; context-compaction turns attach the same
envelope inside a ZIP archive named `codex-compaction-context.zip`. The document is created in
memory and passed to Playwright as a UTF-8 buffer (the archive is built in memory with `fflate`). It
is not written into the repository, workspace, planning directory, or a persistent temporary-file
path.

The composer contains only the fixed transport and capability bootstrap. Compaction changes tool
and output semantics, not context transport. Image bytes stay outside the document as native
attachments with stable references. One of ten attachment slots is always reserved for the context
document, so the newest nine images are retained and older images become explicit placeholders in
the serialized context. The browser re-resolves the current composer while attachments mount and
requires exact attachment evidence, the preserved bootstrap, the selected connector when
applicable, and the current visible, enabled, non-`aria-disabled` Send control before submission.

The context window is 256,000 tokens. Automatic compaction begins at 220,000 tokens, the maximum
compaction input is 244,000 tokens, and 12,000 tokens remain reserved for the checkpoint output,
leaving 24,000 tokens of trigger-to-ceiling headroom. Token accounting counts the bootstrap and
attached context exactly once. Compaction remains a no-tools turn, and its existing server response
conversion stays unchanged. A prompt-level checkpoint marker is translated into a visible Codex trace item;
tool-capable normal turns re-bind the same capability after that checkpoint. Visible ChatGPT status
rows become reasoning summaries, while stable prose between rows becomes native Codex commentary.

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
- Keep browser turns isolated in independent task-bound tabs and reject unsupported models
  explicitly. The selected routed model fixes the adapter effort; a conflicting request effort
  cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
