# Plus Thinking: retained input versus upload capacity

These results describe the combined local candidate. PR #1001 carries the input-budget and
inline policy; PR #1003 carries cache-confidence and fragment recovery. They share necessary
profile/interface changes. Their descriptions list standalone checks and remaining live limits.

## Live checks on 19 November 2026

These tests used a personal Plus account, explicit GPT-5.6 High, and blind random markers at
14 distributed positions. The final question named the record positions, not the expected
marker values. Payloads contained only generated padding and harmless source text; no private
replay text, project files or local work tools were used.

| Mode / transport | Estimated input tokens | Exact markers |
| --- | ---: | ---: |
| Temporary Chat, seven messages | 140,352 | 12/14; oldest two missing |
| Ordinary chat, same seven-message fixture | 140,352 | 12/14; oldest two missing |
| Ordinary chat, six-message smaller control | 112,723 | 14/14 |
| Ordinary chat, single-message comparison | 103,226 | 14/14 |
| Ordinary chat, actual updated helper + legacy-cache path | 118,917 | 14/14 |

The final candidate sent one live request without a live retry, returned every marker exactly,
and removed the unverified legacy cache entry. Reloading its private fixture cache found a
version-2 file with no remaining entry. All four saved test conversations were deleted afterward;
the Temporary Chat surface closed without a saved conversation. No Codex work chat was created,
and no manual compaction was invoked.

The ordinary failed test's network metadata showed all 14 markers in the submitted payloads,
one conversation identity, and the requested `gpt-5-6-thinking` model. Controls and final
validation also confirmed that response model. Successful staging acknowledgements therefore
did not prove complete retention at 140k.

The smaller staged and inline controls used equivalent generated content. The staged run took
106 seconds; the 103k inline run took 33 seconds. The actual 119k candidate also took 33 seconds.
These timings describe the observed runs, not a general performance guarantee.

## Interpretation and implemented policy

The account's model catalog reported `max_tokens=262144` for Thinking; that field alone is not
proof of usable retained input. OpenAI's [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
distinguish a Thinking total window from its input and output allocations. API/Work/Codex limits
are separate product limits. The failed/passing live checks support a conservative input policy
here; they do not locate the exact backend cutoff or establish every account's capacity.

The updated Plus Thinking Bigger Context profile uses 120k input / 110k automatic compaction
for both explicit 5.6 and 6 routes. Only 5.6 was live-tested in these runs; 6 retains its existing
120k profile. Instant, Luna and Pro profiles are preserved. Larger inline input is enabled only
for the supported Plus Thinking routes, with native composer/message limits still enforced.

The earlier generic 3x-message-window calculation did not establish 270k retained input on
this account. Increasing part counts was tested as a prototype and rejected for deployment
after the live retention failure. Ordinary transport remains bounded to two or six parts.

The helper negotiates the expanded inline budget explicitly and rejects mismatched helpers.
Native record fragments also require an advertised decoder feature. A record exceeding known
composer boundaries can be fragmented losslessly instead of waiting for a server rejection.

Version-1 learned limits and rejections from staged/retained context are not treated as proven
maxima for one fresh message. A bounded fresh inline probe must still fit the calibrated input
budget and native physical boundaries. Fresh single-message rejection establishes binding
recovery limits. Confirmed limits retain their private persistent cache, expiry and route scope.
A successful small retained suffix cannot clear a full-request limit. Recovery remains forbidden
after escaped output, local tool activity or cancellation.

## Private replay check

The reporter supplied reconstructed Native history, not a captured original HTTP request.
The original combination uploaded it in six messages at 136,305 estimated input tokens.
With the corrected input policy and legacy-limit interpretation it fits one fresh inline message:
**92,394 tokens**, all **48 compiler records** reconstructed exactly, canonical input unchanged,
and native preflight passed. No replay text or raw diagnostics are committed here.

These live tests verify synthetic transport retention and the final inline/cache path. Sustained
productive work in the reporting computer's original loudness chat remains an acceptance check;
no remote host was available to run it from this environment. Live Pro-account validation also
remains pending.
