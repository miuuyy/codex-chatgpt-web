# Native compaction admission

Native Codex can retain a current environment preamble before an older human
instruction in `replacement_history`. Binding environment discovery to the last
human instruction makes that valid layout fail when the bridge's in-memory
compaction receipt is unavailable. Retrying the same transcript does not repair
the missing receipt.

The HTTP boundary now admits a compacted continuation before interpreting its
trace or opening an SSE stream. A cold continuation reads a single canonical
native rollout and verifies:

- Session identity and root/spawn lineage through the existing filesystem and
  native metadata checks.
- The latest `turn_context` has the exact current turn, model and reasoning
  effort. Both native `effort` and older `reasoning_effort` fields are supported;
  conflicting values fail admission.
- The latest installed checkpoint belongs to the current active native task.
  Completion, cancellation, a replacement checkpoint, an incomplete final JSONL
  record or a concurrent append invalidates the candidate.
- The request's checkpoint summary and retained human source revision match the
  native checkpoint exactly. Current environment messages must match the native
  preamble's item identity and content, including permissions.

The verified execution environment is retained only for that parsed request in
an internal `WeakMap`. A changed request body invalidates it. Current tools come
from the current request, and admission never replays a tool call or starts
browser work. Existing process-local compaction receipts remain a fast path;
they are no longer the only recovery evidence after reconnect or restart.

The adapter's optional `prepareTurn` contract resolves execution authority before
HTTP streaming starts. Unrecoverable authority errors return HTTP 400 with
`trusted_environment_unavailable`, instead of appearing as a broken stream after
browser admission. Direct adapter callers keep the existing `runTurn` validation
fallback.

This changes control metadata and compaction recovery. It does not bypass model
capacity limits or remove the browser UI dependency. A missing native checkpoint,
an unsupported native record format or conflicting evidence still fails closed.
Forward journal scanning is needed only for a cold compaction continuation; it
does not cache conversations or capabilities across requests.

`tests/native-compaction-admission.test.ts` covers cold recovery, completed and
aborted ownership, altered summaries/source/context/model/effort/permissions,
ambiguous and partial journals, request mutation, tool-result rounds, and HTTP
admission for streaming and non-streaming requests. No real ChatGPT request is
required for these checks.
