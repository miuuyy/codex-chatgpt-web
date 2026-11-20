# Learned message limits: account isolation

The maintainer reproduced a genuine size rejection immediately before stream interruption and
reported that switching between two Plus accounts in one launcher profile reused the same saved
limit. The earlier key distinguished model/family/effort and Pro capability, not account identity.

## Correction

The browser resolves the existing SHA-256 account identifier from its authenticated session on
the exact leased ChatGPT surface before the daemon compiles the selected prompt. The persistent
key includes that identifier, model, family, selected effort and Pro capability. No raw user ID,
account ID, email, session credential or access token is stored in the learned-limit cache.

The helper advertises `account-scoped-message-limits`; a daemon requiring this feature refuses
an older helper before dispatch. The identifier is validated at IPC ingress and forwarded before
prompt preparation. This applies to Full and Browser-only turns when Bigger Context is enabled.
Browser-only receives no broker capability or MCP connector.

Each recovery attempt resolves its account again. Before every physical Send, including staging,
the browser verifies that the prepared account is still current. A changed or missing session
stops with `chatgpt_account_changed`; that is not a size rejection and cannot authorize replay.
An unidentified account can use bounded operation-local recovery, but cannot read another
account's saved limits or persist an unidentified entry.

Unscoped entries written by previous revisions cannot be attributed safely to the currently
signed-in account. They are not selected by the new account-qualified keys. Limits are relearned
from fresh rejection evidence; no old entry is assigned speculatively to a user. Existing cache
bounds, expiry, physical preflight and no-replay-after-progress guards remain.

## Regression evidence

The Responses-adapter account-switch regression failed before the fix: account B and an unknown
account both inherited A's multipart requirement. The corrected sequence verifies:

1. A receives a confirmed fresh-message rejection and recovers with its learned target.
2. A's next task uses its own cached target.
3. B, using the same Plus/model/effort/profile, starts with complete inline input.
4. Returning to A restores A's target; an unknown account inherits neither.
5. B learns a different target without narrowing A's.
6. Reloading a fresh store from disk restores both targets under separate account keys.

Other checks exercise operation-local unidentified recovery, pre-Send account switch/sign-out,
malformed identifiers, older helpers, and account forwarding through both real IPC endpoints.
The existing real rejection screenshot and stream fixtures remain in this PR.

## Read-only live account check

On 20 November 2026 (Europe/Berlin), the newly built standalone PR helper leased a fresh browser
surface in the installed launcher and resolved the authenticated account. A deliberate local
stop then prevented prompt compilation. Observed result:

```json
{"accountResolved":true,"prepared":false,"sendActivated":false,"submitted":false,"stoppedBeforePreparation":true}
```

This verifies account lookup and the real helper boundary, not model recovery. It sent no model
request, executed no local work tools and created no saved conversation. The first preparation
attempt hit the existing 5-second DOM observation timeout; it was not retried as model work. The
read-only check passed after the launcher was foregrounded. Account lookup was also corrected
to run after the newly leased idle surface opens ChatGPT.

## Remaining live acceptance

The requested demonstration of the original loudness task resuming on this isolated branch
after a real service rejection remains pending access to the reporting computer. Synthetic
marker checks, captured rejection fixtures and reconstructed-history replay are not that test.
No remote host was supplied, and this evidence makes no claim that the live acceptance passed.

## Reconciliation with 6.1.19 and final checks

The branch uses upstream's shared transport checker and browser-selected transaction ID for
both planning and preflight. Account identity is a separate third prompt-selection argument.
The expanded inline compaction path uses the same selected token/physical limits, preserving
complete fitting history above the retired JSON-byte cap. Genuine confirmed limits stay binding.

An additional functional regression switches the session after preparation while Send waits.
Both inline and multipart cases failed before the final guard moved to Send activation; both
now stop before physical submission. An unsupported GPT-6 Instant transport also stops once
instead of repeating an unchanged size-rejected message four times. This does not restrict
its existing Full-mode tools.

Final `bun run verify` on upstream 8e9fac0 / 6.1.19 completed successfully with Bun 1.4.0 and
Node 24.22.1: 1,241 root tests passed, 112 skipped; 446 launcher tests passed, 2 skipped;
both audits found no vulnerabilities; version/type checks, renderer/runtime builds, notices
and relocated-runtime smoke passed. Earlier 6.1.18 results and audit findings are historical.

The original-task live acceptance boundary above remains unchanged.

## Cold fresh-tab ordering

A read-only installed probe exposed a five-second DOM observation timeout when account lookup
ran full UI preparation too early. A normal preflight reached the Send boundary without sending.
The account lookup now only establishes the authenticated origin before reading the existing
session API; normal UI preparation remains after diagnostics attach. A functional regression
rejects premature UI work, and a fresh real probe resolved the account and stopped before
compilation/Send without foregrounding the app. Final full verification above includes this fix.
