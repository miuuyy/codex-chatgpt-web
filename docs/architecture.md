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

- Exposes the same fixed models and attaches the turn-bound connector capability to every available
  effort, from Luna through Pro. There are no effort-specific MCP exclusions.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents one outer Codex turn capability; the MCP server keeps the derived
  binding private and dispatches the requested action immediately.
- When Codex exposes tools behind its code-mode `exec` gateway, the connector discovers their
  runtime registry and can invoke an exact listed name through bridge-owned code. Full mode also
  preserves Codex's native freeform `exec`; its tool registry enforces the same bounded
  `wait_agent` contract as direct and structured calls.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

### Repository DEV driver

The DEV chat is not another provider or browser implementation. It is a synthetic outer-Codex
driver around the same in-process Responses handlers. `dev launcher` starts the packaged launcher
with an explicit `development` profile. That profile has a different core home, sandboxed
`CODEX_HOME`, Electron `userData`, persistent browser partition, descriptor, cookie jar, login,
configuration, chat store, diagnostic store, broker path, tunnel profile, and alias. The normal and
DEV launchers can therefore run at the same time with different ChatGPT accounts.

The working-tree adapter attaches to a tab leased only from that DEV launcher. In Full mode the DEV
launcher owns one persistent, isolated tunnel runtime; a named CLI chat owns only the private turn
broker attached to that tunnel for the command's lifetime. The distinct `Codex Native2 DEV`
connector reaches the same MCP server and turn-token contract without requiring any Responses
daemon or colliding with the production `Codex Native2` connector.

Only the responsibilities normally owned by native Codex are synthetic: named history storage,
turn metadata, tool-result execution, context-threshold scheduling, and installation of compacted
replacement history. Every tool result is an explicit `simulated: true` receipt with
`side_effects_performed: false`; no semantic router guesses a command result.

The driver calls `responseRequest` and `compactRequest` directly. It starts no HTTP server, does not
read or write Codex's route journal or `config.toml`, and does not stop or replace the normal
launcher-owned daemon. A `dev-harness` discriminator prevents the Responses server and production
launcher from starting a Responses daemon for its config. DEV setup stores browser capabilities
and tunnel credentials but performs no Codex integration, system service installation, or port
probe. The DEV launcher supervisor owns only the isolated MCP tunnel. Browser diagnostics, broker
state, thread authority, checkpoints, and named chat state live
under `~/.codex-chatgpt-web-dev` by default.

The ChatGPT connector name is also the public MCP ABI identity. The direct turn-token contract uses
`Codex Native2`; the retired `Codex Native` identity is never selected or refreshed in place. Setup
migrates known legacy local configuration to the new name, clears prior verification state, and
requires the user to create the new connector. Browser verification accepts the exact new identity,
reports a specific migration error when only the legacy identity is visible, and never falls back to
the legacy connector. Future public schema changes require another explicit connector identity.
Repository DEV mode uses `Codex Native2 DEV` so the same ChatGPT account can keep both production
and development connectors installed without renaming, refreshing, or deleting either one.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each task/model/effort/compaction epoch owns one exact `WebContentsView` lease; sequential
native messages reuse that surface, while each message receives a fresh turn-bound MCP token and
keeps all of its MCP tool rounds inside one ChatGPT response. Compaction asks the same retained Web
agent for a one-shot structured checkpoint, waits for the response and physical helper cleanup,
then closes the old surface. The next epoch gets a new Temporary Chat. Model messages never copy
state between tabs. Tabs share only the local login
partition and keep independent documents and lifecycles. Closing a running tab destroys its page
and terminates that browser turn. A sixth concurrent turn fails explicitly; the cap avoids excessive
parallel traffic that could trigger account abuse controls.

Sign-in uses that same persistent Electron partition. ChatGPT login pages and allowed identity-
provider popups are adopted into a temporary `WebContentsView` inside the launcher instead of being
redirected to another browser. After the provider returns to ChatGPT, the launcher requires both a
server-authenticated session and the Temporary Chat composer in the primary owned view, then closes
the temporary auth view. There is no browser-profile handoff, cookie import, CDP login port, or
temporary session-transfer directory.

The current compiled Codex task context is inserted as one inline JSON envelope. Image bytes stay
out of the JSON and are attached natively with stable references. The runtime does not create a
context JSONL file, upload a synthetic context document, include prompt hashes, or silently truncate
the envelope. Attachment acceptance and send readiness are verified before the turn begins.

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.
Top-level `model_context_window` raises only the proxied native rows' advertised maximum, allowing
Codex to apply its own configured context override without clamping. Routed ChatGPT Web models
retain their measured adapter-owned limits.

In Full mode, routed compaction v1/v2 uses the exact retained source agent and a one-shot MCP control
capability that accepts only the bound checkpoint; it cannot claim or invoke the ordinary Codex tool
environment. A missing retained source falls back to a dedicated read-only Temporary Chat built from
canonical Codex history; an invalid or ambiguous handoff still fails explicitly. Browser-only mode
uses the same read-only summarization path, then returns the native replacement-history shape expected
by Codex. A prompt-level checkpoint marker is translated into a visible Codex trace item;
every later tool action in the same turn continues to present the current turn capability. Visible
ChatGPT status rows become reasoning summaries, while stable prose between rows becomes native
Codex commentary.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no installed Chrome/Chromium or system Node/Bun;
sign-in and model turns both remain in Electron. Full mode separately downloads the official pinned
`openai/tunnel-client` build for the current OS/architecture and verifies it against the release
SHA-256 manifest.

On first launch, the embedded runtime is checked against a deterministic manifest covering every
file path, size, and SHA-256 before any launcher port or window opens. The source, transactional
temporary copy, and final destination are all validated before the private versioned directory is
accepted under the application home. Daemon and MCP commands use that durable copy, which is
required because Linux AppImage mount paths are temporary and must never be persisted in Codex or
tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the optional
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Native login items or an owner-local XDG autostart file launch the app
hidden after sign-in. A marker containing only launcher-owned PIDs lets doctor distinguish the
launcher runtime from a stale or external process. Legacy macOS launchd services are drained and
removed during an explicit launcher migration; launchd remains only for the advanced terminal-only
mode.

Setup keeps Codex's built-in `openai` provider; its only managed provider-routing assignment is
`openai_base_url`. The daemon
forwards the authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed. Subagent protocol selection is explicit,
and new installations default to Compatibility V1 as the conservative cross-backend surface:

- **Compatibility V1** pins every delegation-capable native and routed row to V1 and atomically
  manages `multi_agent = true`, `multi_agent_v2 = false`, and `[agents].max_depth` of at least 2 so
  a routed child can spawn a routed grandchild. The integration journal preserves the user's prior
  scalar, structured-feature, and agent-depth lines and restores them byte-for-byte on disconnect,
  native-mode selection, or uninstall. The ChatGPT connector projects `wait_agent` as an explicit
  10-second polling contract: terminal semantics stay native, while every non-terminal poll releases
  the serialized MCP channel so Web children can run their own harness tools.
- **Native** preserves every official native row and gives routed rows the selected template's
  protocol surface. For authenticated native Responses turns, the proxy recognizes the V2
  collaboration surface in ordinary tools and Responses Lite `additional_tools`, removes the
  `encrypted: true` schema marker only from `spawn_agent`, `send_message`, and `followup_task`
  message fields, and normalizes their returned calls with Codex's explicit
  `encrypted_function_args: []` plaintext-delivery marker. The same marker is emitted directly for
  Web-origin calls. This makes native-to-Web, Web-to-native, and Web-to-Web V2 delegation readable
  across providers while leaving unrelated schemas and encrypted response fields untouched. A
  genuinely encrypted payload is still rejected with one HTTP 400 before a browser is opened; it
  is never turned into an SSE disconnect/retry loop.

Catalog metadata alone never claims to change an existing task's protocol. Codex pins the protocol
when a task starts, and its global `multi_agent_v2` override wins over per-model metadata. Switching
protocol therefore requires restarting Codex Web GPT and Codex, then starting a new task. Model
choice, effort, context, and service tiers are otherwise unchanged.

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
