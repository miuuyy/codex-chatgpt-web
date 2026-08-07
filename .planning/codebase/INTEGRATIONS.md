---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# External Integrations

**Analysis Date:** 2026-08-07

## APIs & External Services

**ChatGPT Web:**
- `https://chatgpt.com` is the browser automation target used for authenticated Temporary Chats.
  - Client: launcher-owned Electron `WebContentsView` plus `playwright-core` attachment through the local CDP surface.
  - Implementation: `src/adapters/chatgpt-web/browser-worker.ts`, `launcher/electron/browser-host.cjs`, and `src/adapters/chatgpt-web/launcher-helper-client.ts`.
  - Auth: existing user-authenticated launcher browser partition; session state is not copied into daemon prompts.

**OpenAI Responses / model catalog:**
- The loopback bridge exposes Responses-compatible endpoints and forwards the authenticated official model catalog while appending routed `chatgpt-web/*` models.
  - Implementation: `src/server.ts`, `src/model-catalog.ts`, `src/bridge.ts`, and `src/native-passthrough.ts`.
  - Setup changes Codex routing through `src/codex-integration.ts` rather than installing a separate static model catalog.

**OpenAI Secure MCP Tunnel:**
- Full mode uses the official tunnel client to connect the ChatGPT custom connector to the local stdio MCP server without opening an inbound public listener.
  - Implementation: `src/tunnel.ts`, `src/tunnel-service.ts`, `src/adapters/chatgpt-web/mcp-main.ts`, `src/adapters/chatgpt-web/mcp-server.ts`, and `launcher/electron/runtime-supervisor.cjs`.
  - Credentials are stored in user-private application files and are not passed as command-line secrets; see `docs/security-model.md`.

## Data Storage

**Databases:**
- Not detected. The application is a local bridge/desktop runtime and does not depend on a database service.

**File Storage:**
- Local filesystem only for application config, runtime descriptors, logs, installed runtime copies, and launcher-owned state via `src/config.ts`, `launcher/electron/state.cjs`, and `launcher/electron/runtime-install.cjs`.
- ChatGPT task-context attachments are constructed in memory and uploaded directly; normal turns use `codex-task-context.txt`, while compaction uses `codex-compaction-context.zip` from `src/adapters/chatgpt-web/prompt.ts`.

**Caching:**
- No external cache service. Response continuation/state is local and bounded in `src/responses/state.ts` and related response modules.

## Authentication & Identity

**ChatGPT identity:**
- The launcher owns a persistent Electron partition for the user's ChatGPT login in `launcher/electron/browser-host.cjs`.
- Browser task isolation is per independent task-bound tab/Temporary Chat, while login state is shared only through that private local partition.

**Local lifecycle authorization:**
- Private admin endpoints use an application-owned bearer token for drain/resume/cancel/shutdown control in `src/server.ts`, `src/service.ts`, and launcher supervision code.
- Responses traffic itself is loopback-only and relies on the same-user local trust boundary documented in `docs/security-model.md`.

**Per-turn tool capability:**
- Full-mode local tool access is scoped to one outer Codex turn through `src/adapters/chatgpt-web/turn-broker.ts` and the MCP server.
- The broker binds a random expiring turn token to the exact tool registry/environment supplied by the outer Codex turn.

## Monitoring & Observability

**Error Tracking:**
- No hosted error-tracking integration detected.

**Logs:**
- Launcher activity/logging is handled locally by `launcher/electron/logging.cjs` with redaction coverage in `launcher/tests/logging.test.cjs`.
- Core failures are surfaced through typed bridge/adapter errors in `src/lib/errors.ts`, `src/bridge.ts`, and `src/adapters/chatgpt-web/*`.

## CI/CD & Deployment

**Hosting:**
- Native desktop artifacts are built by `electron-builder`; there is no hosted web application deployment target.

**CI Pipeline:**
- GitHub Actions in `.github/workflows/ci.yml` runs verification and package smoke checks across supported operating systems.
- `.github/workflows/release.yml` builds platform packages, runs smoke verification, generates license notices, and publishes release artifacts.

## Environment Configuration

**Required env vars:**
- No repository `.env` contract was read or required for this map.
- Runtime/setup values are primarily persisted as application configuration and private credential files rather than expected as checked-in environment configuration; see `src/config.ts`, `src/setup.ts`, and `docs/security-model.md`.

**Secrets location:**
- User-private application-data files with owner-only permissions where supported.
- `.gitignore` excludes `.env`, `*.key`, `storage-state.json`, runtime state, logs, and launcher build/runtime outputs.

## Webhooks & Callbacks

**Incoming:**
- Loopback HTTP Responses/model/lifecycle endpoints are local protocol surfaces, not public webhooks; implementation is centered in `src/server.ts`.
- Launcher browser control uses an authenticated loopback control server in `launcher/electron/control-server.cjs`.

**Outgoing:**
- HTTPS/browser traffic to ChatGPT and OpenAI services.
- Full mode establishes an outbound OpenAI Secure MCP Tunnel; no inbound firewall rule is created.

---

*Integration audit: 2026-08-07*
