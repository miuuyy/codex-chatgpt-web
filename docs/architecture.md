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
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same fixed models; Instant through Extra High are tool-capable, while Pro remains
  read-only.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents one outer Codex turn capability; the MCP server keeps the derived
  binding private and dispatches the requested action immediately.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

The ChatGPT connector name is also the public MCP ABI identity. The direct turn-token contract uses
`Codex Native2`; the retired `Codex Native` identity is never selected or refreshed in place. Setup
migrates known legacy local configuration to the new name, clears prior verification state, and
requires the user to create the new connector. Browser verification accepts the exact new identity,
reports a specific migration error when only the legacy identity is visible, and never falls back to
the legacy connector. Future public schema changes require another explicit connector identity.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each Codex task is leased an independent `WebContentsView` and surface ID; Playwright attaches
to that exact surface through a launcher-owned loopback CDP endpoint. Model turns never launch a
second browser or copy state between turn tabs. Each tab opens a fresh Temporary Chat, shares only
the local login partition, and keeps its own document and lifecycle. Completed tabs remain
inspectable until closed. Closing a running tab destroys its page and terminates that browser turn.
A sixth concurrent turn fails explicitly; the cap avoids excessive parallel traffic that could
trigger account abuse controls.

Sign-in is the deliberate exception. The launcher resolves the operating system's default HTTP
browser and opens it in a dedicated temporary profile so platform passkeys and identity verification remain
available. After that browser exits, the runtime independently proves an authenticated Temporary
Chat composer, filters the captured state to ChatGPT/OpenAI cookies plus ChatGPT local storage,
imports it into the launcher-owned Electron partition, proves the embedded composer again, and
deletes the temporary transfer. Any validation, import, verification, or cleanup failure clears the
partial Electron session and fails explicitly.

The current compiled Codex task context is inserted as one inline JSON envelope. Image bytes stay
out of the JSON and are attached natively with stable references. The runtime does not create a
context JSONL file, upload a synthetic context document, include prompt hashes, or silently truncate
the envelope. Attachment acceptance and send readiness are verified before the turn begins.

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.

Routed compaction v1/v2 runs as a dedicated read-only browser summarization turn with no broker or
local tools, then returns the native replacement-history shape expected by Codex. A prompt-level
checkpoint marker is translated into a visible Codex trace item; every later tool action in the
same turn continues to present the current turn capability. Visible ChatGPT status rows become
reasoning summaries, while stable prose between rows becomes native Codex commentary.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no system Node/Bun. It uses the operating system's
default browser only for the passkey-compatible sign-in handoff; the current login adapter requires a
Chromium-compatible default. Model turns remain in Electron. Full mode separately downloads the official
pinned `openai/tunnel-client` build for the
current OS/architecture and verifies it against the release SHA-256 manifest.

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
`chatgpt-web/` namespace; no static catalog is installed. While the integration is active, native
models that support delegation and routed Web models share Codex's readable V1 collaboration
surface so an explicitly selected Web subagent receives plaintext task content. An explicit native
`disabled` delegation capability is preserved. Model choice, effort, context, and service tiers are
otherwise unchanged.

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
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
