# Standalone token-copy recovery: installed Native2 check

On 20 November 2026 (Europe/Berlin), the installed macOS arm64 Full-mode integration ran
this PR alone on upstream 8e9fac0 / 6.1.19. No message-limit or handoff companion fix was
included. The functional source was commit 7c16596f407d87353bd592607a4ce2ccf81c098e.

## Controlled fault and real action

The acceptance-only browser helper blocked the first marked outbound submission before it
reached ChatGPT and delivered one malformed, missing-character call envelope to the real
stream parser. The selected app and unique current successful connector catalogue still
had to verify the namespace; those identities and progress authority were not faked.

This was **injected stream-envelope evidence**, not a naturally reproduced copy error or a
real rejected Native2 RPC. The normal standalone daemon/helper protocol authorized recovery;
the retry used real ChatGPT and executed the intended harmless scratch command through the
installed Codex/Native2 registry. No DEV simulation or companion recovery performed the action.

| Observation | Count / result |
| --- | ---: |
| Physical submission attempts | 2 |
| Outbound submissions blocked by the harness | 1 |
| Injected malformed envelopes | 1 |
| Real rejected Native2 calls | 0 |
| Automatic token-copy recoveries | 1 |
| Queued outer shell calls | 1 |
| Native command starts / successful completions | 1 / 1 |
| Durable action invocation receipts | 1 |
| Final answer matches the unknown fixture | Yes |
| Selected app/current catalogue identity verified | Yes |

A separate native transcript read confirmed one completed turn, one command with exit code
zero and the exact final answer. An independent durable receipt confirmed the action ran
once. The action was not repeated to improve the result.

## Cleanup warning and final state

The initial driver returned **FAIL** on its extra global-idle assertion: browser activity was
zero, but one global HTTP request remained visible for its 30-second window. That assertion
is not reported as a clean pass. The server counter includes model-list and native passthrough
requests as well as Web turns; a global count alone does not identify the owner.

Inspection of the completed test turn found zero remaining HTTP requests for that native
identity. After retiring the test session, a quiet observation showed zero HTTP and browser
turns. The previous app was restored with its exact runtime hashes and signature verified.
The one approved Codex test chat and its uniquely matched backend conversation were deleted.

These results establish standalone functional recovery and exactly-once action execution.
They do not establish a naturally occurring malformed-token recurrence or a clean first-run
result for every driver postcondition.

## Reproducibility and boundaries

Ordinary standalone runtime bundle:
`d0b570109b7c23ef2b8ccfa9f7c3b1a0bd68ac635ac745e2909fe8fc3ead847f`.

Acceptance-only runtime bundle:
`68e56ab5fe87e09086a619917f081293146941f376cc2440af3f3312d06fff63`.
Only `app/browser-helper.cjs` changed for fault delivery; the standalone CLI remained byte
identical. No live capability value, account/connector identifier, raw transcript, fixture
value, private path or generated runtime is published here.

Source validation passed 162 focused tests, type checks, runtime/renderer builds and relocated
smoke. Root verification reported 1,183 passed / 112 skipped / one unchanged macOS login
abort-message assertion failure, also reproduced on clean upstream. Both dependency audits
found no vulnerabilities. Separately, serial launcher validation passed 446 tests / 2 skipped;
an earlier parallel launcher run hit an unchanged fixture timing failure, retained in local logs.

## Final serial verification follow-up

Using the same durable Bun 1.4.0 and official Node 24.22.1 toolchain as the other final
branch checks, the unchanged macOS assertion passed in isolation. A single subsequent
serial `bun run verify` completed successfully: 1,184 root tests passed / 112 skipped,
446 launcher tests passed / 2 skipped; both audits found no vulnerabilities; version/type
checks, renderer/runtime builds, notices and relocated-runtime smoke passed. Earlier failed
runs remain recorded above. No production or assertion changes were made for this follow-up,
and the installed action was not repeated.
