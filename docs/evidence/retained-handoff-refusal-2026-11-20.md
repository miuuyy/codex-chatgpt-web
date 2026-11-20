# Retained handoff: terminal missing receipt and refusal regression

The maintainer correctly noted that a missing checkpoint can follow an explicit refusal.
No authenticated refusal discriminator was available in the captured worker result. Plain
assistant text, empty output, a network failure or missing DOM cannot prove non-refusal.

The earlier blanket missing-receipt retry is withdrawn. A missing receipt remains terminal;
its exact rejected result is retained within the existing 30-minute cache lifetime so that
retirement cannot turn a reconnect into a new source-unavailable fallback. Changed native
input gets a different key. Existing typed source-unavailable recovery remains.

The adapter regression failed before this correction: an explicit refusal caused two browser
attempts. Removing only the first retry was insufficient: reconnect evicted the rejected run
and started a fresh fallback. Retaining the terminal missing-receipt result fixed both paths.

Fixtures cover explicit refusal, empty/ordinary completion, quoted refusal text, transport/DOM
errors and exact reconnect. A valid broker-accepted checkpoint quoting a refusal still succeeds:
text matching is not used as an authority signal. An already accepted checkpoint with matching
one-shot token and handoff ID is the existing positive path when only its acknowledgement was
lost; no new model request is needed.

Final full `bun run verify` on upstream 8e9fac0 / 6.1.19 completed successfully, serially with
Bun 1.4.0 and Node 24.22.1: both frozen installs passed; audits found no vulnerabilities;
1,158 root tests passed / 112 skipped; 446 launcher tests passed / 2 skipped; version/type
checks, renderer/runtime builds, notices and relocated-runtime smoke passed.

Earlier checks retained two failures in unchanged tests: one heavy multipart timeout and the
macOS abort-message assertion. The original logs remain; no assertion changes or blind retry
loop was used. Final verification used isolated physical frozen dependencies and restored both
original dependency symlinks with the same inode and target afterward.

No new refusal DOM/network detector or speculative selector is introduced. These are adapter
and broker contract regressions, not a captured live service refusal. No live ChatGPT task,
new chat or project action was performed for this PR revision. Selective recovery for an ordinary
missing receipt would require authoritative positive evidence that is not currently available.
