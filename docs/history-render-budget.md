# Offscreen conversation history

Large ChatGPT conversations retain old user inputs and answers in the page. The
bridge now applies `content-visibility:auto` and a 700px intrinsic placeholder to
older top-level turn roots during the existing submission DOM observation. Text,
order and stable identities remain in the DOM. The latest two roots keep normal
rendering, including the active response, composer and model/effort controls.
The policy uses existing `data-turn-key` and `data-turn-id-container` identities;
nested containers receive no duplicate budget. Unsupported browsers keep the
previous rendering behavior.

An acknowledged multipart stage can be remounted with a new display identity.
Skipped offscreen layout can make its `innerText` empty. Reconciliation reads
`textContent` only for a deferred stage and still requires exact uploaded text,
a unique readable assistant-owned plain ACK, a following readable completion
control and no surviving duplicate. Hidden/quoted ACKs, hidden completion,
changed payloads and foreign exchanges remain errors. Live response extraction
and tool ACK/emission retain their existing contract.

`tests/history-render-budget.test.ts` exercises the actual production callbacks
with 320,000 and 1,000,000 source characters, legacy and grouped identities,
cache reuse, new-turn growth, current-response projection and tool ACK ordering.
It also reproduces the deferred `innerText` case and rejects invalid receipts.
The grouped markup follows `tests/fixtures/chatgpt-power-complete.html` and the
multipart history fixture; the legacy markup follows the submission identity
fixtures in `tests/browser-worker-contract.test.ts`. All browser traffic is
offline. No authenticated ChatGPT message is submitted.

These fixtures validate DOM semantics, not live latency or sustained memory
reduction. Performance and authenticated browser behavior need account-bound
verification; fixtures alone do not establish them.
