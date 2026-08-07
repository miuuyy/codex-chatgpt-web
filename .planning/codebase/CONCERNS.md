---
last_mapped_commit: 7907fd28de5978967a7e8b7c260e44d1280c9732
---

# Codebase Concerns

**Analysis Date:** 2026-08-07

## Tech Debt

**Large orchestration modules:**
- Issue: Several critical modules concentrate many state-machine branches and platform/UI edge cases.
- Files: `src/adapters/chatgpt-web/browser-worker.ts` (~2500 lines), `launcher/src/App.tsx` (~1700 lines), `launcher/electron/browser-host.cjs` (~1650 lines), `launcher/electron/runtime-supervisor.cjs` (~1650 lines), `src/bridge.ts` (~1150 lines).
- Impact: Changes have a wider regression surface and require careful caller/test tracing even when the requested behavior is small.
- Fix approach: Do not refactor speculatively. When a concrete change repeats logic or exposes an ownership boundary, extract only the smallest stable helper/module and keep the existing public contract.

**Dual runtime/module styles:**
- Issue: Root runtime uses Bun/TypeScript ESM while Electron main-process code is large CommonJS JavaScript.
- Files: `package.json`, `tsconfig.json`, `launcher/package.json`, `launcher/electron/*.cjs`.
- Impact: Type guarantees and test/tooling conventions differ across the core/launcher boundary.
- Fix approach: Preserve the boundary unless a planned migration has measurable value; shared contracts should remain narrow and validated rather than duplicated.

## Known Bugs

**No confirmed unresolved functional bug identified from the mapped HEAD:**
- Symptoms: Not applicable.
- Files: Mapping is based on HEAD `7907fd28de5978967a7e8b7c260e44d1280c9732`; the current branch name alone is not treated as proof of an unresolved defect.
- Trigger: Not applicable.
- Workaround: Not applicable.

**Expected external UI failures are operational risks, not silent fallbacks:**
- Symptoms: ChatGPT DOM/model-picker/composer changes can make a browser turn fail before or after submission evidence.
- Files: `src/adapters/chatgpt-web/browser-worker.ts`, `launcher/electron/browser-host.cjs`.
- Trigger: ChatGPT Web UI semantics/selectors no longer match the enforced contract.
- Workaround: Update the narrow selector/postcondition implementation and its contract tests; do not add a second hidden transport or guessed fallback.

## Security Considerations

**Same-user loopback trust boundary:**
- Risk: Another process running as the same OS user can reach the loopback Responses port; the built-in Codex provider cannot attach an independent bridge bearer credential to normal Responses traffic.
- Files: `src/server.ts`, `src/codex-integration.ts`, `docs/security-model.md`.
- Current mitigation: Loopback-only binding; lifecycle endpoints separately require a random application-owned bearer token; local code execution is explicitly inside the trust boundary.
- Recommendations: Preserve loopback binding and exact trusted-environment extraction; do not treat user-authored prompt/environment text as authority.

**Browser session / tunnel credential sensitivity:**
- Risk: Compromise of the launcher partition or tunnel credentials can authorize ChatGPT/OpenAI access.
- Files: `launcher/electron/browser-host.cjs`, `src/tunnel.ts`, `launcher/electron/runtime-supervisor.cjs`, `docs/security-model.md`.
- Current mitigation: User-private storage, no prompt/runtime-descriptor copying of browser state, no secret command-line arguments, logging redaction.
- Recommendations: Keep credentials file-backed/private, retain redaction tests, and fail closed when ownership/permissions are invalid.

**Prompt injection reaches local tools in full mode:**
- Risk: Repository/web/tool-output content is untrusted but becomes visible to ChatGPT; an injected instruction could request a destructive tool.
- Files: `src/adapters/chatgpt-web/turn-broker.ts`, `src/adapters/chatgpt-web/mcp-server.ts`, `docs/security-model.md`.
- Current mitigation: Exact per-turn tool registry/capability binding; Codex still enforces its sandbox/approval/UI policy.
- Recommendations: Keep the broker transport-only and avoid adding semantic auto-approval or broader tool authority inside the bridge.

## Performance Bottlenecks

**Browser automation latency:**
- Problem: Each routed task uses a fresh Temporary Chat and waits for browser hydration, attachment readiness, submission evidence, and remote model completion.
- Files: `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/attachment-readiness.ts`, `launcher/electron/browser-host.cjs`.
- Cause: Correctness requires DOM/postcondition synchronization against an external product UI; model response time is remote.
- Improvement path: Optimize only measured redundant waits/probes while retaining exact postconditions and cancellation behavior.

**Verification/package cost:**
- Problem: `bun run verify` runs audit, both test suites, typechecks, launcher build, runtime bundle, license generation, and smoke verification.
- Files: `scripts/verify.ts`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
- Cause: Cross-platform native packaging/runtime correctness has many independent contracts.
- Improvement path: Keep targeted tests for local iteration; retain the full verification pipeline before release/ship.

## Fragile Areas

**ChatGPT composer/model/response DOM state machine:**
- Files: `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/attachment-readiness.ts`, `tests/browser-worker-contract.test.ts`.
- Why fragile: The external DOM is not a stable API, attachments can replace the composer subtree, and retrying after ambiguous submission can duplicate a prompt.
- Safe modification: Trace current active-composer resolution through submission acknowledgement before editing; preserve exact evidence checks and abort/page-close safety.
- Test coverage: Strong contract coverage exists, but live UI changes can still invalidate selectors/semantics outside repository control.

**Task-context file transport and compaction:**
- Files: `src/adapters/chatgpt-web/prompt.ts`, `src/server.ts`, `tests/context-file-transport.test.ts`, `tests/server-compaction.test.ts`, `tests/chatgpt-web-harness.test.ts`.
- Why fragile: Normal and compaction turns share context semantics but have different MIME/container formats, strict filename/schema requirements, a ten-attachment limit, and exact token accounting.
- Safe modification: Change compiler + boundary validation + readiness logic together; run the dedicated context/compaction contract tests before broad verification.
- Test coverage: High for current invariants; keep new cases atomic and contract-oriented.

**Turn broker lifecycle:**
- Files: `src/adapters/chatgpt-web/turn-broker.ts`, `src/adapters/chatgpt-web/index.ts`, `tests/turn-broker-lifecycle.test.ts`.
- Why fragile: Capabilities must be bound exactly once/idempotently, revoked on every terminal path, and never cross task/environment identities.
- Safe modification: Start from token/binding/retirement invariants and audit every caller/cleanup path before changing behavior.
- Test coverage: Dedicated lifecycle tests exist; security-sensitive changes should preserve negative cases as well as success paths.

**Launcher runtime supervision:**
- Files: `launcher/electron/runtime-supervisor.cjs`, `launcher/electron/runtime.cjs`, `src/service.ts`, `launcher/tests/runtime-supervisor.test.cjs`, `launcher/tests/runtime-host.test.cjs`.
- Why fragile: It coordinates tunnel readiness, daemon health, drain/resume/shutdown, crash recovery, platform-specific paths, and restore-on-failure behavior.
- Safe modification: Preserve fail-closed lifecycle ordering and prove both request/browser counters idle before destructive lifecycle actions.
- Test coverage: Broad unit/contract suite plus package/runtime smoke checks.

## Scaling Limits

**Browser task concurrency:**
- Current capacity: No fixed application-level tab maximum; each task owns an independent Electron surface/Temporary Chat.
- Limit: Machine resources and ChatGPT account/product-side controls are the practical boundary.
- Scaling path: Profile BrowserHost/memory/process overhead before introducing any application-level scheduler or cap.

**ChatGPT attachment count:**
- Current capacity: Ten attachments per message, with one slot permanently reserved for task context and the newest nine image attachments retained.
- Limit: Older images become explicit placeholders once the native message exceeds that retained-image budget.
- Scaling path: Only change if the upstream ChatGPT attachment contract changes; keep `CHATGPT_MAX_INPUT_ATTACHMENTS` and transport tests synchronized.

**Context window/compaction:**
- Current capacity: Architecture docs specify a 256k window, automatic compaction starting at 220k, maximum compaction input 244k, and 12k reserved checkpoint output.
- Limit: Requests outside those transport/accounting limits must be compacted or rejected according to the current contract.
- Scaling path: Update `src/chatgpt-web-limits.ts` and matching tests only from verified provider/model constraints.

## Dependencies at Risk

**ChatGPT Web DOM contract:**
- Risk: This is an external consumer UI, not a supported automation API.
- Impact: Selector/label/structure drift can stop routed turns even if local code is unchanged.
- Migration plan: No hidden alternative transport is part of the architecture; maintain the narrow UI adapter and fail explicitly until a supported product contract exists.

**OpenAI tunnel client/runtime packaging:**
- Risk: Full mode depends on the official pinned platform build and its status/readiness behavior.
- Impact: Version/platform/runtime drift can prevent MCP connectivity.
- Migration plan: Keep checksummed/pinned packaging and runtime verification in launcher setup/supervision instead of downloading unverified binaries dynamically.

## Missing Critical Features

**No critical product gap inferred by mapping alone:**
- Problem: Codebase mapping documents current behavior; selecting the next product/project requirements belongs to `$gsd-new-project` questioning.
- Blocks: Nothing in the mapping step itself.

## Test Coverage Gaps

**Live ChatGPT end-to-end drift:**
- What's not tested: Repository tests cannot guarantee the current live ChatGPT UI/model-picker/connector DOM still matches the automated contract at every moment.
- Files: `src/adapters/chatgpt-web/browser-worker.ts`, `launcher/electron/browser-host.cjs`.
- Risk: A provider UI rollout can break production behavior between code releases.
- Priority: High operationally; runtime must keep failing closed with actionable diagnostics.

**Numeric code coverage enforcement:**
- What's not tested: No minimum coverage percentage is enforced by `package.json`/CI.
- Files: `package.json`, `scripts/verify.ts`, `.github/workflows/ci.yml`.
- Risk: New branches could be added without coverage if reviewers do not require a focused runnable check.
- Priority: Medium; current behavior-first contract tests are extensive, so add thresholds only if an actual coverage regression problem emerges.

---

*Concerns audit: 2026-08-07*
