---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# Testing Patterns

**Analysis Date:** 2026-08-07

## Test Framework

**Runner:**
- Bun 1.3.11 `bun:test` for root TypeScript tests in `tests/*.test.ts`.
- Node built-in `node:test` for launcher CommonJS tests in `launcher/tests/*.test.cjs`.
- Config: no separate Jest/Vitest config; scripts are declared directly in `package.json` and `launcher/package.json`.

**Assertion Library:**
- Built-in assertions exposed by Bun test APIs for core tests.
- Node's built-in assertions with `node:test` for launcher tests.

**Run Commands:**
```bash
bun test tests/*.test.ts          # Core test suite
bun run launcher:test             # Launcher node:test suite
bun run typecheck                 # Root strict TypeScript check
bun run launcher:typecheck        # Launcher TypeScript check
bun run verify                    # Full repository verification/build/smoke pipeline
```

## Test File Organization

**Location:**
- Root runtime tests are separate from implementation under `tests/`.
- Launcher tests are separate from implementation under `launcher/tests/`.

**Naming:**
- Core: `tests/<behavior>.test.ts`.
- Launcher: `launcher/tests/<behavior>.test.cjs`.

**Structure:**
```text
tests/
├── server-compaction.test.ts
├── context-file-transport.test.ts
├── browser-worker-contract.test.ts
├── turn-broker-lifecycle.test.ts
└── ...

launcher/tests/
├── browser-host.test.cjs
├── runtime-supervisor.test.cjs
├── design-contract.test.cjs
└── ...
```

## Test Structure

**Suite Organization:**
```typescript
import { expect, test } from "bun:test";

test("normal turns attach a plain UTF-8 text document; compaction attaches a ZIP archive", () => {
  // arrange relevant request/context
  // call the narrow compiler/adapter helper
  // assert the exact transport contract
});
```

**Patterns:**
- Tests are behavior-named and contract-oriented, often encoding an invariant directly in the test title.
- Prefer direct unit/contract exercise of exported helpers and injected fakes rather than large shared fixture frameworks.
- Async tests use `async`/`await`; cancellation/timeouts are exercised explicitly for browser/runtime lifecycle code.
- Platform-specific behavior is tested with controlled platform inputs where possible instead of relying on the current host OS.

## Mocking

**Framework:** Lightweight hand-written fakes/stubs and built-in test facilities; no dedicated mocking library is declared.

**Patterns:**
```typescript
test("browser stage timeout aborts late page acquisition", async () => {
  const controller = new AbortController();
  // inject a delayed/fake boundary and assert cancellation/postconditions
});
```

**What to Mock:**
- Process/browser/network boundaries that can be represented as narrow injected functions or fake objects.
- Electron WebContents/CDP actions in launcher unit tests where actual browser ownership is not the subject of the test.
- External tunnel/provider behavior behind local contracts.

**What NOT to Mock:**
- Pure parsing/serialization/schema helpers; exercise real implementation directly.
- The release smoke path in `scripts/verify.ts`, which intentionally builds a runtime bundle and runs smoke verification.

## Fixtures and Factories

**Test Data:**
```typescript
const request = {
  // small inline object containing only the fields relevant to the contract
};
```

**Location:**
- Fixtures are generally inline or local helper functions inside the owning test file.
- No large shared fixture directory is part of the mapped repository structure.

## Coverage

**Requirements:** No numeric coverage threshold is configured in the package scripts.

**View Coverage:**
```bash
bun test --coverage tests/*.test.ts
```

`coverage/` is ignored by `.gitignore`; coverage is available for diagnostics but is not the primary enforced metric.

## Test Types

**Unit Tests:**
- Pure request parsing, error classification, model contracts, token/context limits, config helpers, path/runtime helpers.

**Integration/Contract Tests:**
- Server lifecycle and Responses bridge behavior in `tests/server-lifecycle.test.ts`, `tests/bridge-platform.test.ts`, and related files.
- Browser-helper/control protocol and launcher ownership in `tests/launcher-browser-host.test.ts`, `tests/launcher-helper-client.test.ts`, and launcher test files.
- Context transport and compaction invariants in `tests/context-file-transport.test.ts`, `tests/server-compaction.test.ts`, and `tests/chatgpt-web-harness.test.ts`.

**E2E / Smoke Tests:**
- Release/runtime smoke checks are scripted in `scripts/smoke-release.ts` and `scripts/smoke-codex-catalog.ts`.
- Packaged desktop smoke behavior is covered by `launcher/scripts/smoke-package.cjs` and the CI/release workflows.
- Browser UI behavior is heavily contract-tested against fakes/selectors; live ChatGPT remains an external UI whose drift is handled by fail-closed runtime checks.

## Common Patterns

**Async Testing:**
```typescript
test("turn cancellation aborts the active file attachment stage", async () => {
  // start operation
  // abort the owning signal
  // await rejection/cleanup and assert no late side effect
});
```

**Error Testing:**
```typescript
test("model unavailable remains an invalid-model failure instead of overload", () => {
  // classify a concrete failure and assert the exact typed result
});
```

## Verification Pipeline

`scripts/verify.ts` is the canonical aggregate gate. It creates a temporary scratch directory and runs, in order: version consistency, `bun audit`, root typecheck, root tests, launcher typecheck, launcher tests, launcher build, runtime-bundle build, third-party notice generation, and runtime smoke verification. The scratch directory is removed in `finally`, keeping generated verification artifacts out of the repository.

---

*Testing analysis: 2026-08-07*
