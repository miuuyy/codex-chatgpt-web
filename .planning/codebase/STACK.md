---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# Technology Stack

**Analysis Date:** 2026-08-07

## Languages

**Primary:**
- TypeScript 5.9.3 - Core daemon, CLI, ChatGPT Web adapter, build scripts, and root test suite under `src/`, `scripts/`, and `tests/`.
- TSX/React - Launcher renderer UI in `launcher/src/App.tsx` and `launcher/src/main.tsx`.

**Secondary:**
- CommonJS JavaScript - Electron main-process and launcher runtime code in `launcher/electron/*.cjs` plus launcher scripts/tests.
- CSS - Launcher presentation tokens and component styles in `launcher/src/tokens.css` and `launcher/src/styles.css`.
- Shell/PowerShell - Installation entry points in `scripts/install.sh`, `scripts/install-launcher.sh`, and `scripts/install-launcher.ps1`.

## Runtime

**Environment:**
- Bun 1.3.11 is the root package manager and runtime. `package.json` requires `>=1.3.11 <1.4`.
- Electron 41.7.1 hosts the desktop launcher and authenticated ChatGPT browser surfaces from `launcher/electron/main.cjs`.
- Node's built-in test runner is used by launcher tests via `launcher/package.json`; packaged users do not need a system Node/Bun because the launcher ships the required runtime.

**Package Manager:**
- Bun 1.3.11.
- Lockfile: `bun.lock` is committed at the repository root.

## Frameworks

**Core:**
- `@modelcontextprotocol/sdk` ^1.30.0 - MCP server/protocol integration used by full mode.
- `playwright-core` ^1.62.0 - Browser automation client that attaches to launcher-owned Electron surfaces.
- `chromium-bidi` 12.1.0 - Browser protocol support used by the runtime/browser stack.
- React ^19.0.0 + React DOM ^19.0.0 - Desktop launcher renderer in `launcher/src/`.
- Electron 41.7.1 - Desktop shell, persistent ChatGPT partition, and process supervision.

**Testing:**
- `bun:test` - Root tests in `tests/*.test.ts`.
- `node:test` - Launcher tests in `launcher/tests/*.test.cjs`.

**Build/Dev:**
- TypeScript 5.9.3 with strict checking from `tsconfig.json`.
- Vite ^6.0.0 + `@vitejs/plugin-react` ^5.2.0 build the launcher renderer.
- `electron-builder` ^26.8.1 packages macOS, Windows, and Linux launcher artifacts from `launcher/package.json`.

## Key Dependencies

**Critical:**
- `zod` 4.4.3 - Runtime schema validation across request, configuration, and adapter boundaries.
- `fflate` ^0.8.2 - Builds in-memory ZIP transport for ChatGPT compaction context in `src/adapters/chatgpt-web/prompt.ts`.
- `turndown` 7.2.0 + `turndown-plugin-gfm` 1.0.2 - Converts browser-rendered content to Markdown in `src/adapters/chatgpt-web/markdown.ts`.
- `motion` ^12.42.2 - Launcher renderer transitions in `launcher/src/App.tsx`.

**Infrastructure:**
- Bun's HTTP/process/filesystem APIs power the loopback daemon and release tooling in `src/server.ts`, `src/process.ts`, and `scripts/verify.ts`.
- Electron WebContents/CDP ownership is encapsulated in `launcher/electron/browser-host.cjs` and `launcher/electron/cdp-input.cjs`.

## Configuration

**Environment:**
- Runtime configuration is represented by typed application config in `src/config.ts` and setup flows in `src/setup.ts`.
- Launcher state/config is persisted under the application home by modules such as `launcher/electron/state.cjs`, `launcher/electron/window-state.cjs`, and `launcher/electron/runtime.cjs`.
- Credentials are intentionally file-backed/private rather than embedded in generated profiles or command arguments; see `docs/security-model.md`.
- `.env` is ignored by `.gitignore`; no `.env` file was read during this map.

**Build:**
- Root TypeScript: `tsconfig.json`.
- Root scripts and release verification: `package.json`, `scripts/verify.ts`, `scripts/build-runtime-bundle.ts`.
- Launcher build/package configuration: `launcher/package.json` and `launcher/scripts/package.cjs`.
- CI/release automation: `.github/workflows/ci.yml` and `.github/workflows/release.yml`.

## Platform Requirements

**Development:**
- Bun 1.3.11-compatible environment with dependencies installed from `bun.lock`.
- Launcher development additionally builds/runs Electron and Vite through `launcher/package.json`.

**Production:**
- Native desktop packages target macOS, Windows, and Linux in `launcher/package.json`.
- The desktop package embeds a platform-matched Bun runtime and relocates it to a durable private directory before the launcher supervises the daemon; see `launcher/electron/runtime-install.cjs` and `docs/architecture.md`.

---

*Stack analysis: 2026-08-07*
