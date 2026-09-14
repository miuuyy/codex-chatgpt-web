# Optional model for Pro compaction

**Settings → Pro compaction model** changes only the summary generated when an
automatic ChatGPT Web Pro task compacts its history. Ordinary task turns keep
their original model.

| Choice | Summary execution |
| --- | --- |
| Follow main task (default) | Existing behavior; no override |
| GPT-5.6 Extra High | GPT-5.6 at Extra High effort |
| GPT-5.6 Pro | GPT-5.6 at Pro effort |
| GPT-5.5 Pro | GPT-5.5 at Pro effort |

The first request for a logical compaction pins the choice. Reconnects join that
same run even if the setting changes meanwhile. A new choice applies to the next
compaction; it does not interrupt active work, restart the service, or alter the
Codex model catalogue. Zero Risk, Luna, non-Pro tasks, and accounts without the
required controls keep their existing behavior.

## Behavior and limits

Extra High sends the summary at Extra High rather than Pro effort. The two fixed
Pro choices send the summary with the selected Pro family. ChatGPT still controls
which families and efforts are available, how usage is counted, and when limits
reset. This setting does not bypass those controls.

A different summary model can change checkpoint quality and latency. It does not
repair an expired session, browser disconnect, invalid handoff, or unavailable
model.

## Execution boundaries

1. Codex still decides when to compact. This setting does not change context or
   compaction thresholds.
2. Source lookup, transaction identity, cancellation, deduplication, and
   retirement remain tied to the original Pro request. Only the summary execution
   receives the selected family and effort.
3. The retained-source handoff remains the primary path. If the retained source is
   unavailable, the existing read-only fresh-chat fallback uses the same pinned
   summary choice. Browser-only summaries follow the same rule and do not gain
   ordinary Codex tools.
4. Multipart preparation for an explicit override stays below Pro effort. If one
   indivisible record needs Pro's larger message envelope, the request fails before
   sending instead of spending an extra Pro message during staging.
5. Immediately before submission, the bridge verifies the live family, effort,
   and numeric picker position. Missing or contradictory state fails explicitly;
   no other model is substituted.
6. Existing checkpoint validation, browser cleanup, and the five-minute structured
   handoff liveness budget are unchanged. An accepted prompt is not retried.

## Configuration and compatibility

The optional core field is `compactionModel`, with values `extra-high`,
`5.6-pro`, or `5.5-pro`. Omitting it means follow-main. The launcher writes the
field through its authenticated control channel, and setup or application updates
preserve the rest of the existing configuration.

The runtime and browser helper must both advertise `compaction-execution`. An old
helper cannot ignore an explicit choice: the request fails before submission.
Unknown settings and inconsistent execution payloads are rejected.

The production service reads the preference for each new eligible compaction. The
isolated DEV named-chat CLI snapshots configuration at startup, so reopen that CLI
after changing the DEV preference. The launcher itself does not need to restart.

## Picker-state regression checks

The family list belongs to the composer-owned menu. Its collapsed advanced view can
remain attached and geometrically visible while `inert`, so visibility alone does
not prove that a model row is clickable. The selector expands a collapsed model
trigger before a normal actionability-checked click. It reuses a family only when
its unique exact model row is explicitly checked; a rendered 5.6 label under
Latest is not proof that 5.6 is pinned.

After changing the control, checked state and spoken family/effort each receive a
bounded, read-only settling window of up to one second. This does not retry an
accepted prompt or extend compaction's handoff budget. Immediate pre-send
verification stays strict; unavailable or contradictory state still blocks sending.

`tests/pro-model-picker-dom.test.ts` runs the actual selector against an offline
HTML fixture in a fresh headless Chromium context, including inert rows and an
unrelated duplicate model outside the owned menu. Network requests are blocked;
it neither opens a logged-in profile nor submits a ChatGPT prompt. The tests are
skipped unless an existing Chromium executable is explicitly supplied:

```bash
CHATGPT_PICKER_TEST_CHROME=/absolute/path/to/chrome bun test tests/pro-model-picker-dom.test.ts
```

These offline checks are not a substitute for an authenticated, installed
integration test on each model.
