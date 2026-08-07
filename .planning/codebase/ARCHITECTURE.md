---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# Architecture

**Analysis Date:** 2026-08-07

## Pattern Overview

**Overall:** Local protocol bridge with adapter-driven browser execution and an Electron-owned runtime/browser host.

**Key Characteristics:**
- Codex talks to a loopback Responses-compatible daemon in `src/server.ts`; native traffic can pass through while `chatgpt-web/*` routes are translated to browser turns.
- Browser automation is intentionally separated from process/browser ownership: the TypeScript worker in `src/adapters/chatgpt-web/browser-worker.ts` attaches to exact launcher-owned Electron surfaces rather than launching a second browser.
- Full mode adds a one-turn capability broker and MCP/tunnel path; browser-only mode omits those components entirely.
- Context transport is file-based for every ChatGPT browser turn, with normal and compaction variants compiled by `src/adapters/chatgpt-web/prompt.ts`.

## Layers

**CLI and Setup Layer:**
- Purpose: User commands, install/setup/doctor/service/tunnel routing, and Codex route integration.
- Location: `src/cli.ts`, `src/setup.ts`, `src/doctor.ts`, `src/service.ts`, `src/tunnel-service.ts`, `src/codex-integration.ts`.
- Contains: command parsing, config mutation, lifecycle negotiation, health checks.
- Depends on: configuration, daemon/service helpers, launcher/runtime integration.
- Used by: terminal users and launcher runtime operations.

**Responses Transport Layer:**
- Purpose: Accept Codex/OpenAI-compatible requests, normalize routing, stream Responses SSE/JSON, and manage compaction.
- Location: `src/server.ts`, `src/bridge.ts`, `src/responses/`, `src/http-body.ts`.
- Contains: request parsing, model routing, SSE conversion, response state, compaction handling.
- Depends on: provider adapters and configuration.
- Used by: Codex app/CLI through loopback HTTP.

**Provider Adapter Layer:**
- Purpose: Convert parsed Codex requests into provider-specific execution and adapter events.
- Location: `src/adapters/base.ts`, `src/adapters/chatgpt-web/index.ts`, `src/adapters/chatgpt-web/turn-execution.ts`.
- Contains: adapter contract, ChatGPT session state, tool result replay, usage/event translation.
- Depends on: browser worker, prompt compiler, model routing, turn broker.
- Used by: `src/server.ts` and `src/bridge.ts`.

**Browser Execution Layer:**
- Purpose: Drive one ChatGPT Temporary Chat turn with exact model/effort/connector/attachment/submission semantics.
- Location: `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/attachment-readiness.ts`, `src/adapters/chatgpt-web/launcher-helper-client.ts`.
- Contains: composer selection, attachment readiness, prompt insertion, response DOM tracing, completion evidence, recovery logic.
- Depends on: launcher-owned surface/control protocol and Playwright.
- Used by: ChatGPT Web adapter execution.

**Capability/MCP Layer:**
- Purpose: Bind one outer Codex turn's allowed tools/environment to ChatGPT connector calls.
- Location: `src/adapters/chatgpt-web/turn-broker.ts`, `src/adapters/chatgpt-web/mcp-server.ts`, `src/adapters/chatgpt-web/mcp-main.ts`, `src/tunnel.ts`.
- Contains: turn token/binding lifecycle, tool-call forwarding, stdio MCP server, tunnel integration.
- Depends on: outer Codex tool registry and full-mode configuration.
- Used by: tool-capable ChatGPT turns only.

**Desktop Host Layer:**
- Purpose: Own Electron windows, persistent login partition, browser task surfaces, runtime installation, and child supervision.
- Location: `launcher/electron/main.cjs`, `launcher/electron/browser-host.cjs`, `launcher/electron/runtime-supervisor.cjs`, `launcher/electron/runtime-install.cjs`.
- Contains: browser/tab leases, CDP endpoint ownership, daemon/tunnel lifecycle, state/log persistence, IPC.
- Depends on: Electron and packaged runtime files.
- Used by: launcher renderer and TypeScript browser helper/client.

**Launcher Renderer Layer:**
- Purpose: Desktop setup, browser surface controls, MCP onboarding, activity, and settings UI.
- Location: `launcher/src/App.tsx`, `launcher/src/main.tsx`, `launcher/src/i18n.ts`, `launcher/src/styles.css`.
- Contains: React UI and IPC-facing state rendering.
- Depends on: Electron preload bridge from `launcher/electron/preload.cjs`.
- Used by: desktop users.

## Data Flow

**Normal ChatGPT Web Responses turn:**

1. Codex sends a Responses request to loopback `src/server.ts`.
2. Request parsing/routing selects a fixed ChatGPT Web model through `src/model-catalog.ts`, `src/responses/parser.ts`, and `src/server.ts`.
3. `src/adapters/chatgpt-web/prompt.ts` serializes the sanitized Codex context into one in-memory `codex-task-context.txt` attachment and keeps native image attachments separate.
4. `src/adapters/chatgpt-web/index.ts` starts a browser turn; `browser-worker.ts` attaches to the task-owned launcher surface and configures model/effort/connector state.
5. Attachment readiness verifies exact current-composer evidence, then the browser submits once Send is conclusively enabled.
6. Browser DOM trace/final Markdown is converted into adapter events, then `src/bridge.ts` emits Responses-compatible SSE/JSON back to Codex.

**Tool-capable full-mode turn:**

1. The daemon creates a turn capability in `src/adapters/chatgpt-web/turn-broker.ts` from trusted outer turn metadata.
2. ChatGPT invokes the custom MCP connector through the outbound tunnel and stdio MCP server.
3. Broker calls are limited to tools advertised by that outer turn; Codex executes them locally and returns tool results.
4. The same ChatGPT response continues with those results until the browser response is complete.

**Compaction turn:**

1. `src/server.ts` identifies compaction metadata and routes through `src/responses/compaction.ts`.
2. The same sanitized context envelope is zipped in memory by `src/adapters/chatgpt-web/prompt.ts` as `codex-compaction-context.zip`.
3. Compaction is no-tools; prompt markers are translated back into a visible Codex trace event without fabricating a separate browser history checkpoint.

**State Management:**
- Response continuation and replay are local/bounded in `src/responses/state.ts`.
- Per-browser-turn session state is held by `src/adapters/chatgpt-web/index.ts` and launcher task-tab ownership.
- Launcher durable state is file-backed under the app home via `launcher/electron/state.cjs` and related modules.

## Key Abstractions

**ProviderAdapter:**
- Purpose: Stable bridge contract between Responses routing and provider execution.
- Examples: `src/adapters/base.ts`, `src/adapters/chatgpt-web/index.ts`.
- Pattern: Adapter interface + provider-specific implementation.

**TurnBroker:**
- Purpose: One-turn capability boundary for local Codex tools.
- Examples: `src/adapters/chatgpt-web/turn-broker.ts`.
- Pattern: Expiring opaque token/binding lifecycle with explicit request/result batches.

**BrowserHost / launcher surface lease:**
- Purpose: Bind a Codex task to exactly one owned Electron surface while preserving shared login state only at the partition level.
- Examples: `launcher/electron/browser-host.cjs`, `src/launcher-browser-host.ts`.
- Pattern: Ownership/lease protocol around Electron WebContents and authenticated loopback control.

**Compiled ChatGPT Web prompt:**
- Purpose: Keep transport bootstrap separate from complete serialized conversation context and image references.
- Examples: `src/adapters/chatgpt-web/prompt.ts`.
- Pattern: Deterministic prompt + exact context attachment contract.

## Entry Points

**CLI:**
- Location: `src/cli.ts`.
- Triggers: `codex-chatgpt-web`, `bun run start`, setup/doctor/service/tunnel commands.
- Responsibilities: parse commands, run setup/lifecycle operations, or start the daemon.

**Responses daemon:**
- Location: `src/server.ts`.
- Triggers: loopback HTTP requests.
- Responsibilities: models, responses, compaction, health, lifecycle control, routing, counters.

**Desktop launcher:**
- Location: `launcher/electron/main.cjs`.
- Triggers: Electron application startup.
- Responsibilities: window/tray/IPC, state, BrowserHost, runtime supervision, packaged renderer loading.

**Browser helper:**
- Location: `src/adapters/chatgpt-web/browser-helper-main.ts`.
- Triggers: launcher/runtime helper protocol.
- Responsibilities: executes browser-worker operations against the launcher-owned surface.

## Error Handling

**Strategy:** Fail closed at trust boundaries and browser-state ambiguity; classify expected transient/capacity conditions separately from protocol or ownership failures.

**Patterns:**
- Typed/centralized bridge error conversion in `src/lib/errors.ts`, `src/bridge.ts`, `src/adapters/chatgpt-web/capacity-error.ts`, and `src/adapters/chatgpt-web/transient-limit-error.ts`.
- Abort-aware async browser stages in `src/adapters/chatgpt-web/index.ts` and `browser-worker.ts` stop cleanly when the outer turn or launcher surface ends.
- Runtime lifecycle code proves drain/idleness before stop/restart and restores state when possible in `src/service.ts` and `launcher/electron/runtime-supervisor.cjs`.

## Cross-Cutting Concerns

**Logging:** Launcher logging is centralized/redacted in `launcher/electron/logging.cjs`; core adapter/bridge errors are converted into structured response events.
**Validation:** Zod and explicit schema/type guards validate request/config/context attachment/control boundaries across `src/responses/schema.ts`, `src/config.ts`, and `src/adapters/chatgpt-web/prompt.ts`.
**Authentication:** ChatGPT login stays in the launcher partition; lifecycle endpoints use a private bearer token; full-mode tools additionally require the per-turn broker capability.

---

*Architecture analysis: 2026-08-07*
