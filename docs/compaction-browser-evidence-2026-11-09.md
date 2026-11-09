# GPT-6 Web compaction: sanitized field observations (2026-11-09)

These are **selected event names, UTC timestamps, numeric counters and model/effort
labels** from a local Linux launcher run. Browser URLs, conversation IDs, trace IDs,
prompt text, tool inputs/outputs, local paths and credentials are excluded.

**Account capabilities:** GPT-6 model selection and Extra High were available;
the launcher reported `proAvailable=true`. **The exact subscription tier is not
established by these records**; Pro availability is a capability, not proof of
a subscription tier. Both observations were from the same authenticated
browser setup. This evidence is not a controlled experiment.

## Failure (original six-part transport, before the patch)

```text
2026-11-09T11:28:59Z  compaction uses configured fresh conversation mode
2026-11-09T11:29:00Z  transport=multipart-6; estimatedInputTokens=225325; compactionTrimmedMessages=0
2026-11-09T11:29:05Z  part=1/6; effort=low; modelFamily=6; estimatedMessageTokens=34300
2026-11-09T11:29:06Z  part=1/6 submission accepted; acknowledgement started
2026-11-09T11:29:12Z  part=1/6 acknowledgement completed; durationMs=6408
2026-11-09T11:29:14Z  part=2/6; effort=low; modelFamily=6; estimatedMessageTokens=39452
2026-11-09T11:29:16Z  part=2/6 submission accepted; acknowledgement started
2026-11-09T11:32:16Z  part=2/6 acknowledgement timed out; durationMs=180003
```

**Interpretation:** part 2 was submitted, but its expected acknowledgement was
not observed within the deadline. The logs do **not** establish an explicit
cumulative-size rejection. A lower staging effort and a longer upload were
both present; their separate causal contributions remain unproven.

## Successful two-part transport (combined patch under test)

```text
2026-11-09T12:23:29Z  compaction uses configured fresh conversation mode
2026-11-09T12:23:36Z  transport=multipart-2; estimatedInputTokens=89993; compactionTrimmedMessages=34
2026-11-09T12:23:41Z  part=1/2; effort=xhigh; modelFamily=6; estimatedMessageTokens=42936
2026-11-09T12:23:43Z  part=1/2 submission accepted; acknowledgement started
2026-11-09T12:23:50Z  part=1/2 acknowledgement completed; durationMs=7383
2026-11-09T12:23:52Z  final effort selection completed; effort=xhigh
2026-11-09T12:23:53Z  part=2/2 final submission prepared; effort=xhigh; modelFamily=6; estimatedMessageTokens=38832
2026-11-09T12:23:54Z  part=2/2 submission accepted
2026-11-09T12:24:47Z  browser turn completed; markdownChars=8214
2026-11-09T12:24:47Z  browser.turn_ended status=completed
```

## Native Codex continuation after this successful compaction

The local Codex session journal for the same native session records:

```text
2026-11-09T12:24:51Z  compacted
2026-11-09T12:25:40Z  task_started
2026-11-09T12:25:40Z  browser new turn started (fresh Temporary Chat)
2026-11-09T12:25:50Z  new message submission accepted
2026-11-09T12:38:07Z  new browser turn completed
2026-11-09T12:38:08Z  task_complete
```

During that post-compaction task there were **37 native function calls and
37 matching function-call outputs** in the Codex journal. The browser had
closed the compaction tab and opened a new temporary conversation. The original
task's native session therefore **continued performing work after compaction**
and reached a completed native turn. This does not isolate whether effort
preservation or history reduction caused the improvement.

**Limits:** The observations were not collected as a controlled A/B test.
The successful run simultaneously changed the upload count, effort and
available history, so it cannot attribute causality to any single change.
No rejected HTTP size response is claimed.
