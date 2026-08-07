---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# Coding Conventions

**Analysis Date:** 2026-08-07

## Naming Patterns

**Files:**
- Core modules use descriptive kebab-case names such as `native-passthrough.ts`, `process-line-writer.ts`, and `attachment-readiness.ts`.
- Tests mirror the behavior being specified with `*.test.ts` or `*.test.cjs`, for example `tests/context-file-transport.test.ts` and `launcher/tests/runtime-supervisor.test.cjs`.

**Functions:**
- `camelCase` for functions, including internal helpers (`routeChatGptWebRequest`, `compileChatGptWebPrompt`, `secureTokenMatches`).
- Predicate helpers read as conditions (`containsChatGptCompactionMarker`, `isChatGptWebContextAttachment`, `smokePassedForCurrentVersion`).

**Variables:**
- `camelCase` for locals and state.
- `UPPER_SNAKE_CASE` for immutable module constants such as `CHATGPT_MAX_INPUT_ATTACHMENTS`, `MAX_BODY_BYTES`, and browser selector constants.

**Types:**
- `PascalCase` for interfaces/types/classes (`SetupOptions`, `TurnBroker`, `RuntimeSupervisor`, React component props).
- Domain-specific type names encode the protocol boundary (`BrokerToolRequest`, `CodexParsedRequest`, `ChatGptWebContextAttachment`).

## Code Style

**Formatting:**
- No repository Prettier/Biome configuration was detected in the mapped file list.
- Existing TypeScript uses semicolons, double-quoted strings, trailing commas in multiline structures, and explicit return types on exported/public functions where useful.
- CommonJS launcher code follows the same compact imperative style while using `require`/`module.exports` at the Electron boundary.

**Linting:**
- No ESLint/Biome lint command is defined in `package.json`.
- `tsconfig.json` enables `strict: true`; typechecking is therefore the primary static code-quality gate.
- CI also runs dependency audit, version checks, tests, builds, packaging, and smoke verification through `scripts/verify.ts`.

## Import Organization

**Order:**
1. Node/Bun platform imports such as `node:fs`, `node:path`, or runtime globals.
2. Third-party packages such as `zod`, `playwright-core`, or MCP SDK modules.
3. Relative project modules grouped by domain.

**Path Aliases:**
- No TypeScript path alias configuration is present in `tsconfig.json`; modules use relative imports.

## Error Handling

**Patterns:**
- Fail fast on invalid command/config/protocol state with explicit `Error` values or typed domain errors.
- Normalize provider failures before producing wire output in `src/lib/errors.ts` and `src/bridge.ts`.
- Preserve abort semantics in async browser/tool flows (`src/adapters/chatgpt-web/index.ts`, `browser-worker.ts`) instead of converting cancellation into generic failure.
- Security- or lifecycle-sensitive operations fail closed when ownership, authentication, drain state, or browser evidence is ambiguous; examples live in `src/service.ts`, `src/server.ts`, and `launcher/electron/runtime-supervisor.cjs`.
- Recovery is bounded and postcondition-driven in browser/runtime code rather than retrying blindly.

## Logging

**Framework:** Local structured launcher logger plus response/adapter error events; no hosted logging SDK.

**Patterns:**
- Launcher operations use `launcher/electron/logging.cjs`; tests in `launcher/tests/logging.test.cjs` explicitly enforce redaction of sensitive identifiers and credentials.
- Browser diagnostics redact context envelopes/capability values; contract coverage is in `tests/browser-worker-contract.test.ts`.
- User-facing daemon failures are converted into Responses error payloads instead of dumping arbitrary internal state.

## Comments

**When to Comment:**
- Comments are sparse and normally explain non-obvious protocol/UI edge cases or why a branch must wait/fail closed.
- Prefer descriptive helper names and executable tests over explanatory prose for ordinary behavior.

**JSDoc/TSDoc:**
- Not a dominant pattern. Public contracts are primarily expressed through TypeScript interfaces/types and focused tests.

## Function Design

**Size:**
- Most support modules use small helpers around a larger domain orchestrator.
- Some intentionally central modules are very large (`src/adapters/chatgpt-web/browser-worker.ts`, `src/bridge.ts`, `launcher/electron/browser-host.cjs`, `runtime-supervisor.cjs`); modify them through the smallest existing helper/call path rather than adding a parallel abstraction.

**Parameters:**
- Structured option/config objects are preferred when a function needs multiple related values, e.g. setup/config/adapter constructors.
- `AbortSignal` is threaded through long-running async browser operations where cancellation must be observable.

**Return Values:**
- Domain objects and discriminated events are preferred over loosely structured tuples.
- Async lifecycle/browser helpers return promises and throw on failed postconditions.

## Module Design

**Exports:**
- Export the minimal callable/type surface needed by sibling modules and tests; keep helper functions module-local by default.
- Provider-neutral interfaces live in shared modules such as `src/adapters/base.ts`; ChatGPT-specific types stay under `src/adapters/chatgpt-web/`.

**Barrel Files:**
- No broad barrel-file pattern is used. Imports generally target the owning module directly.

---

*Convention analysis: 2026-08-07*
