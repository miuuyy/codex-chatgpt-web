# ChatGPT UI contracts

ChatGPT rolls out individual components independently. A markdown composer, an older
model menu and grouped messages can coexist. An account plan, launcher version or
calendar date must not select a whole-page adapter.

This directory owns DOM recognition, UI labels and control interaction. Requested
models, effort policy and final model verification remain in
`../adapters/chatgpt-web/model-selection.ts`. Authentication, chat URLs and account
capability probing remain in `../chatgpt-session.ts`; turn lifecycle and submission
ownership remain in `../adapters/chatgpt-web/browser-worker.ts`. Import UI helpers
from their owner directly; the session module does not re-export them.

## Evidence and coverage

Dates below mean a capture date when one is recorded, otherwise the date support was
added to this repository. They are **not** upstream release dates, rollout percentages
or proof that an older UI has disappeared. Retained variants have no established
retirement date.

| Component / owner | Evidence | Regression coverage under `tests/` |
| --- | --- | --- |
| Lexical composer — `composer.ts` | Tracked since [17ff8f1](https://github.com/miuuyy/codex-chatgpt-web/commit/17ff8f1), 2026-07-28; original capture date unknown | `chatgpt-session.test.ts`, `chatgpt-effort-browser.test.ts` |
| Markdown composer — `composer.ts` | [2933410](https://github.com/miuuyy/codex-chatgpt-web/commit/2933410), 2026-09-25 | Same tests, including editor replacement and unrelated editable fields |
| Think pill / brain sprite / codex sprite — `composer.ts` | Captures dated 2026-09-08, 2026-10-11 and [#902](https://github.com/miuuyy/codex-chatgpt-web/issues/902), added 2026-10-28 | `fixtures/chatgpt-composer-think*.html`, `browser-generation.test.ts`; English semantic button retained separately for #766 |
| Stop test ID / localized primary action — `composer.ts` | Primary-action capture 2026-10-09, [844a82e](https://github.com/miuuyy/codex-chatgpt-web/commit/844a82e) | `fixtures/chatgpt-composer-stop.html`, `browser-generation.test.ts` |
| Reasoning slider / power slider — `model-picker.ts` | Reasoning tracked by [0dfacc6](https://github.com/miuuyy/codex-chatgpt-web/commit/0dfacc6), 2026-08-08; power added in 2933410, 2026-09-25 | `chatgpt-session.test.ts`, `chatgpt-effort-browser.test.ts`; lock and hydration rejection cases |
| Inline reasoning trigger — `model-picker.ts` | 2026-10-29, [#924](https://github.com/miuuyy/codex-chatgpt-web/issues/924): menu button retains reasoning navigation target and selected effort, without tone, test ID or codex trigger | `chatgpt-session.test.ts`, `chatgpt-effort-browser.test.ts`, `chatgpt-ui-observations*.test.ts`: localized label, unrelated controls, retained triggers, selection and pre-Send verification with three/five/six-position fixtures |
| Shared family rows and split/versioned announcements — `model-picker.ts` | Power-header capture 2026-09-29; shared GPT-6 support [388fca5](https://github.com/miuuyy/codex-chatgpt-web/commit/388fca5), 2026-10-08 | `fixtures/chatgpt-model-picker-power-2026-09-29.html`, `chatgpt-model-family-browser.test.ts` |
| Explicit Sol / Astra rows and six positions — `model-picker.ts` | [#921](https://github.com/miuuyy/codex-chatgpt-web/pull/921), 2026-10-28; independent report [#923](https://github.com/miuuyy/codex-chatgpt-web/issues/923) | `fixtures/chatgpt-model-picker-explicit-2026-10-28.html`; Sol High / Extra High, Astra Max, missing model and conflicting identity |
| Repeated header version / Chinese effort labels — `model-picker.ts` | #875 in [6f43747](https://github.com/miuuyy/codex-chatgpt-web/commit/6f43747), 2026-10-21; #911 in [6140f0b](https://github.com/miuuyy/codex-chatgpt-web/commit/6140f0b), 2026-10-25 | `chatgpt-model-selection.test.ts`, `chatgpt-effort-browser.test.ts` |
| Article turns / grouped turns — `turns.ts` | Grouped renderer added in 2933410, 2026-09-25; article support predates it | `browser-turn-binding.test.ts`, `browser-live-progress.test.ts`; nested old-looking markup must not create a second turn |

The dated picker HTML files are behavioral fixtures reconstructed from observed
structure, not complete original DOM captures. Tests verify our behavior against that
structure; they do not prove how many live accounts still use it.

For the October 29 trigger, @iminfine reported the Chinese Plus macOS failure in
[#924](https://github.com/miuuyy/codex-chatgpt-web/issues/924);
[@zmahomedy](https://github.com/miuuyy/codex-chatgpt-web/issues/924#issuecomment-6488779755)
provided the attributes and zero matches for all three old selectors on macOS Pro.
[@etsynam-pixel](https://github.com/miuuyy/codex-chatgpt-web/issues/924#issuecomment-6488964620)
confirmed the selector failure on Windows Plus; @nofihq reported the same attributes on Linux in #928.
The language-independent structural selector was independently proposed by
@kaimiller144-web in [#927](https://github.com/miuuyy/codex-chatgpt-web/pull/927) and
@nofihq in [#928](https://github.com/miuuyy/codex-chatgpt-web/pull/928).
The selected-effort attribute identifies the control; it does not authorize an effort.
The existing menu verification still checks the requested model and slider position before Send.

The account model catalog is not a remaining-allowance measurement. An observed
October 31 restriction kept GPT-6 presets advertised as available but replaced the
intended thinking model with a smaller default and removed the usable effort slider.
`model-availability.ts` passively reads only the owned page's startup response and
reports `chatgpt_reasoning_limit` only when a future reasoning restriction, matching
model limit and explicit fallback agree. It does not issue requests, infer Pro
exhaustion, select the fallback or cancel a submission after Send activation.
Unreferenced `sr-only` quota strings are template labels, not active-limit evidence.
Closed trigger labels exclude hidden animated placeholders; exact model/family and
effort verification still runs before Send.

Other UI contracts still live with their specialized reader: connector pill/menu
verification in `browser-worker.ts` (including the 2026-10-14 `app-mention-*` format),
expanded user bubbles in the same file (2026-10-15), CodeMirror responses in
`markdown.ts` / `browser-worker.ts` (2026-10-11), and response structure / Activity in
`browser-response-structure.ts`. Their existing captures and rejection tests must
move with the owner if those readers are extracted. Do not treat these independent
features as a new whole-page version.

## Adding and retiring a variant

1. Establish the changed DOM from a sanitized capture or an identified report. Record
   its date, source and affected component beside the code. If only Git history is
   available, say so; do not invent a capture date.
2. Put recognition in the component owner. Keep model/turn decisions in their current
   owners. An unknown or ambiguous control must fail; another model or another turn
   is not a substitute. Cover the new shape and retained shapes in the same tests.
3. Existing diagnostic checkpoints now include `uiVariants`: repository-defined
   component names with attached/rendered counts, capped at 40. Separate `ui_variants`
   lines include the same counts in failure safe logs. No labels, text, IDs or account data
   are copied. These are local observations, not fleet telemetry or routing inputs.
4. A zero count on one page, a closed menu, a different account or an old date does
   not establish retirement. Use recent reporter evidence across the relevant
   account/layout combinations. If support is intentionally dropped before its
   disappearance is known, make that an explicit support decision.
5. Remove an unreachable or redundant branch only after checking its callers and
   rejection tests. For a supported shape, remove its selector, interaction branch,
   diagnostic entry and fixture together, and state the evidence in the commit.
   Keep a rejection case if the unsupported shape could otherwise select the wrong
   model or bind another turn.

The observation map covers structural composer, Think, Stop, model-control, slider and turn variants.
It does not infer semantic model-row generations or report a global ChatGPT UI version.

Run the relevant browser fixtures with `CHATGPT_DOM_TEST_BROWSER` pointing to a local
Chromium executable, then `bun run verify`. A live model-selection check is still
required before declaring a new picker ready for release.
