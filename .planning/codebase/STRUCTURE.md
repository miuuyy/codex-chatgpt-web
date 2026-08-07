---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# Codebase Structure

**Analysis Date:** 2026-08-07

## Directory Layout

```text
codex-chatgpt-web/
├── src/                         # Core Bun/TypeScript runtime and provider bridge
│   ├── adapters/chatgpt-web/    # ChatGPT browser adapter, broker, MCP, prompt, helper
│   ├── responses/               # Responses parsing/state/compaction/reasoning envelopes
│   ├── lib/                     # Small shared helpers such as errors/token estimates
│   ├── usage/                   # Usage accounting
│   └── web-search/              # Synthetic web-search tool representation
├── tests/                       # Bun tests for core/runtime/browser contracts
├── launcher/
│   ├── electron/                # Electron main process, browser host, runtime supervisor
│   ├── src/                     # React/Vite desktop renderer
│   ├── scripts/                 # Launcher dev/package/runtime preparation scripts
│   └── tests/                   # Node test suite for launcher contracts
├── scripts/                     # Root build/install/verify/release scripts
├── docs/                        # Architecture, security, and diagnostic notes
├── .github/workflows/           # CI and release pipelines
├── .planning/codebase/          # GSD-generated codebase reference documents
├── package.json                 # Core package/scripts/dependencies
├── tsconfig.json                # Strict root TypeScript config
└── bun.lock                     # Locked dependency graph
```

## Directory Purposes

**`src/`:**
- Purpose: All core daemon, CLI, integration, response bridge, and provider logic.
- Contains: TypeScript modules organized by runtime concern.
- Key files: `src/cli.ts`, `src/server.ts`, `src/bridge.ts`, `src/config.ts`, `src/codex-integration.ts`.

**`src/adapters/chatgpt-web/`:**
- Purpose: Everything specific to ChatGPT Web execution.
- Contains: browser worker, prompt compilation, exact attachment readiness, turn execution, launcher helper client, turn broker, MCP server, markdown conversion.
- Key files: `src/adapters/chatgpt-web/index.ts`, `browser-worker.ts`, `prompt.ts`, `turn-broker.ts`, `mcp-server.ts`.

**`src/responses/`:**
- Purpose: Provider-neutral Responses wire parsing and state semantics.
- Contains: request schema/parser, compaction helpers, response state, reasoning envelope handling.
- Key files: `src/responses/parser.ts`, `src/responses/schema.ts`, `src/responses/compaction.ts`, `src/responses/state.ts`.

**`launcher/electron/`:**
- Purpose: Native desktop host and ownership boundary.
- Contains: BrowserHost, runtime installation/supervision, control server, state/logging, CDP input, IPC, window/autostart/process helpers.
- Key files: `launcher/electron/main.cjs`, `browser-host.cjs`, `runtime-supervisor.cjs`, `runtime.cjs`, `control-server.cjs`.

**`launcher/src/`:**
- Purpose: React desktop control-center UI.
- Contains: main screen composition, icons, i18n, types, styles, onboarding media.
- Key files: `launcher/src/App.tsx`, `main.tsx`, `i18n.ts`, `styles.css`, `tokens.css`.

**`tests/`:**
- Purpose: Core behavior and contract coverage with Bun.
- Contains: broad tests for server lifecycle, context transport, browser worker behavior, model catalog, broker, launcher helper, setup, tunnel, and platform behavior.
- Key files: `tests/browser-worker-contract.test.ts`, `tests/chatgpt-web-harness.test.ts`, `tests/context-file-transport.test.ts`, `tests/server-compaction.test.ts`.

**`launcher/tests/`:**
- Purpose: Node tests for Electron/launcher logic without requiring full packaged execution for each assertion.
- Contains: BrowserHost, runtime supervisor/install/host, packaging/design contracts, control server, logging, atomic file behavior.
- Key files: `launcher/tests/browser-host.test.cjs`, `runtime-supervisor.test.cjs`, `design-contract.test.cjs`.

**`scripts/`:**
- Purpose: Repository operations and release pipeline helpers.
- Contains: build, clean, verify, smoke, install, license, launcher-start, version-check scripts.
- Key files: `scripts/verify.ts`, `build-runtime-bundle.ts`, `smoke-release.ts`, `start-launcher.ts`.

## Key File Locations

**Entry Points:**
- `src/cli.ts`: CLI executable and command dispatch.
- `src/server.ts`: loopback Responses daemon.
- `launcher/electron/main.cjs`: Electron main-process startup.
- `launcher/src/main.tsx`: renderer bootstrap.
- `src/adapters/chatgpt-web/browser-helper-main.ts`: browser-helper process entry.
- `src/adapters/chatgpt-web/mcp-main.ts`: stdio MCP entry.

**Configuration:**
- `package.json`: core scripts/dependencies/runtime version.
- `launcher/package.json`: Electron renderer/package configuration.
- `tsconfig.json`: strict root TypeScript compiler settings.
- `.github/workflows/ci.yml`: continuous verification matrix.
- `.github/workflows/release.yml`: release packaging/publishing flow.

**Core Logic:**
- `src/server.ts`: routing, HTTP lifecycle, compaction entry.
- `src/bridge.ts`: provider events to Responses SSE/JSON.
- `src/adapters/chatgpt-web/index.ts`: adapter/session orchestration.
- `src/adapters/chatgpt-web/browser-worker.ts`: ChatGPT UI execution and response observation.
- `launcher/electron/browser-host.cjs`: owned Electron browser surfaces.
- `launcher/electron/runtime-supervisor.cjs`: tunnel/daemon process lifecycle.

**Testing:**
- `tests/*.test.ts`: core Bun test suite.
- `launcher/tests/*.test.cjs`: launcher Node test suite.
- `scripts/verify.ts`: aggregate repository verification pipeline.

## Naming Conventions

**Files:**
- Kebab-case TypeScript modules: `context-file-transport.test.ts`, `turn-broker.ts`, `launcher-helper-client.ts`.
- Test files end in `.test.ts` or `.test.cjs` and live in dedicated test directories.
- Electron CommonJS modules remain `.cjs` to make the main-process boundary explicit inside a package using ESM elsewhere.
- React renderer components are consolidated in PascalCase `launcher/src/App.tsx` with supporting lowercase modules.

**Directories:**
- Lowercase/kebab-case domain folders such as `src/adapters/chatgpt-web/` and `src/web-search/`.
- Generated/build/runtime directories are clearly separated (`dist/`, `launcher/build/`, `launcher/release/`, `.launcher-runtime/`) and ignored by Git.

## Where to Add New Code

**New provider-neutral Responses behavior:**
- Primary code: `src/responses/` or the narrow bridge/server module that owns the wire behavior.
- Tests: matching focused file under `tests/`.

**New ChatGPT Web behavior:**
- Implementation: `src/adapters/chatgpt-web/` in the smallest module that owns the browser/prompt/broker concern.
- Tests: `tests/`, usually extending a focused contract file such as `browser-worker-contract.test.ts` only when the behavior belongs there.

**New launcher runtime behavior:**
- Implementation: `launcher/electron/`.
- Tests: `launcher/tests/` with `.test.cjs`.

**New launcher UI:**
- Implementation: `launcher/src/`, with renderer behavior centered in `App.tsx` and styles in `styles.css`/`tokens.css` unless the change warrants a focused module.
- Tests: launcher design/contract tests in `launcher/tests/` as appropriate.

**Utilities:**
- Shared core helpers: `src/lib/` only for behavior genuinely reused across domains.
- Launcher-specific helpers: keep beside the owning Electron/renderer layer rather than moving them into core runtime code.

## Special Directories

**`.planning/`:**
- Purpose: GSD project/codebase planning artifacts.
- Generated: Yes, workflow-managed.
- Committed: Yes when `commit_docs=true`.

**`dist/`, `launcher/build/`, `launcher/release/`:**
- Purpose: generated runtime/renderer/package outputs.
- Generated: Yes.
- Committed: No; excluded by `.gitignore`.

**`output/` and `launcher/artifacts/`:**
- Purpose: transient inspection/browser-test artifacts.
- Generated: Yes.
- Committed: No; excluded by `.gitignore`. Keep browser-test artifacts here rather than under watched source/planning paths.

**`.launcher-runtime/`:**
- Purpose: local launcher/runtime development state.
- Generated: Yes.
- Committed: No; excluded by `.gitignore`.

---

*Structure analysis: 2026-08-07*
