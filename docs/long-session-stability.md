# Long-session admission, recovery and CoS

The Responses and MCP request formats are unchanged. A parsed request is admitted once;
its body, parsed context, model, effort and compaction flags are captured alongside the
trusted execution environment. Execution rejects a changed request with HTTP 400
`turn_preflight_changed`. A thread-only cache entry is not current-turn authority.

Native checkpoint source instructions and post-checkpoint instructions remain separate
authenticated sequences. Incomplete native JSONL writes are different from conflicting
identity, permissions or instructions. Admission watches the validated native journal and
performs at most three reads over a one-second waiting budget. If the write remains
incomplete, HTTP 503 `native_snapshot_not_ready` and `Retry-After: 1` arrive before adapter
creation or SSE. Complete conflicting records retain their non-retryable validation errors.
Reading and validation time is additional to the waiting budget. Cancellation closes the
watcher; a subsequent attempt authenticates the current journal again.

The existing turn registry remains the browser execution owner. Reconnection replays its
event journal and queued tool batch, and physical retirement gates replacement work.
HTTP disconnect does not become user cancellation. A native stop or superseding instruction
retires the capability. Browser submission and tool invocation are not recovery actions.

Browser response verification remains append-only. Cosmetic DOM wrappers, code toolbars,
formula hydration and virtualized owned nodes are normalized. Delivered content, ordered
source ranges and link destinations cannot be rewritten. React state is consulted only
under a response with exactly one explicit message ID and a matching assistant message;
unknown, foreign or contradictory private state is ignored. It cannot bypass a running
generation or the visible completion controls. The requested effort is never downgraded,
and same-origin navigation alone is not proof of owned-conversation continuity.

## Optional CoS features

`cos-settings.json` in the selected runtime profile accepts:

```json
{
  "outputLimit": true,
  "observeWindow": true,
  "goalLoop": true,
  "dashboard": true,
  "dashboardPort": 17842
}
```

Defaults are false; development and custom profiles do not inherit production settings.
The build ships `WindowCapture.cs` beside `cli.js`. On Windows, `observe_window` claims the
current MCP turn before invoking an asynchronous, cancellable Windows PowerShell helper.
Text output is bounded by a shared UTF-8 byte budget while retaining both ends; images,
structured results and metadata retain their contracts. Screenshot files remain in the
profile's `captures` directory.

DEV interactive chat enables goal repetition only for a direct `[goal]`, `[목표]`, `/goal`,
`#goal` or `goal:` command. The normal native Codex goal scheduler retains ownership of
native tasks; CoS does not submit synthetic instructions to desktop chats. External
verification and local fallback use one durable 30-additional-dispatch budget. Explicit
new instructions, cancellation and completion discard pending replies. Restart restores
the consumed budget but never an active goal or queued follow-up. Repeating the same
objective does not reset its budget. An optional HTTPS evaluator uses `evaluatorEndpoint`
and `evaluatorModel`; its credential is read from `secrets/cos-evaluator-key`, outside Git.
No credential, token or message body is emitted in diagnostic events.

The dashboard binds only to loopback. It shows runtime health, aggregate token usage,
explicit goal status and a bounded event list. Goal-stop requests require the exact host,
same Origin and JSON content type. Model/account data is never interpolated as HTML.
Dashboard failure does not stop the core runtime. No external home-directory modules or
self-patching watcher are required.

## Launcher recovery and responsiveness

Repeated identical browser progress keeps updating the owner lease without publishing a
new renderer state more often than every five seconds, keeping freshness indicators live.
Real stage/tool-count changes still publish immediately. Renderer log
delivery batches every 100 ms with a 300-record backlog. This bounds render work during
large tool-output bursts without altering persisted logs.

Daemon and tunnel recovery track consecutive failed attempts independently of the existing
60-second burst limit. Five failed recoveries open the circuit even if attempts take more
than a minute. Fully successful recovery clears its budget; explicit startup/Repair also
grants a fresh budget. Failure publishes the last redacted reason. Background retries do
not silently reopen the circuit.

## Installation evidence

Before integrated installation, preserve both runtime directories, launcher archive,
profile configuration and original CoS modules. Build with the version pinned in
`package.json`, verify every manifest SHA-256 and resolved path, and smoke-test in isolated
homes without ChatGPT prompts. Install only after HTTP and browser work are both idle,
including pending owner cleanup. Launcher, daemon and MCP must move together. Validate
both installed manifests, process ownership, health and tunnel readiness; restore the
preserved installation on failure. Active work leaves a prepared candidate pending.

Offline fixture tests, builds and hashes are not evidence that a user's resumed Web task
succeeded. That result must be observed separately after the user resumes it.
