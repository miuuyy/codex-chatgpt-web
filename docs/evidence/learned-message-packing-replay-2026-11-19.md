# Learned-limit packing replay

A private reconstructed Native history reproduced a remaining failure in the initial version
of this recovery patch. The history came from the latest compacted replacement history plus
subsequent visible response items, rather than a captured original HTTP body. The input and
raw diagnostics are intentionally excluded from the repository.

The frozen route was GPT-5.6 Sol High on Plus, Full mode, with skill attachments enabled.
The learned limits were 89,811 characters and 31,861 tokens per visible message.

| Check | Before | Combined fixed candidate |
| --- | --- | --- |
| Unrestricted upload | 2 parts, 121,239 estimated input tokens | Same input |
| Upload with learned limits | Rejected by the six-message packer | 6 parts, 136,305 estimated input tokens |
| Largest complete message | No fitting result | 83,868 characters; 23,695 tokens |
| Original context records | 48 | All 48 restored exactly from 53 wire records |
| Canonical parsed input | Retained | Byte-equivalent JSON before and after compilation |
| Native browser preflight | Never reached | Passed with three different transaction IDs |

The isolated message-limit branch also restored all 48 records and passed the same three
preflight checks: 148,583 estimated input tokens, at most 83,868 characters and 23,683 tokens
per message. Its prompt accounting differs because it excludes the companion patches.

The previous fragmenter split only records above 80% of the smallest part budget. Medium
records stayed indivisible, leaving gaps between upload parts despite sufficient aggregate
space. The fallback now splits records at actual message boundaries and checks complete
formatted messages, including wrappers, manifest hashes, the final instructions and skill
file tokens. It preserves roles, record order and exact decoded contents.

The compiler regression uses public synthetic 12-record and 13-record examples under those
same limits. Both failed with the initial recovery patch. Further checks cover physical
upload-pressure scheduling, unchanged checkpoint continuations, truly excessive uploads,
attached skill tokens, and required compaction context that cannot fit physical limits.

When physical upload capacity becomes the constraint, usage asks Codex to compact through
its existing automatic loop. A completed tool round can still report that pressure even
if its expanded replay no longer fits. This usage signal cannot authorize an oversized
browser submission. Compaction retains its cumulative-checkpoint protections.

These are offline compiler and preflight results, not evidence of a successful live
continuation on the reporting computer. The corrected combined build still needs to be
installed and exercised there. The isolated PR branch has its own test/build results in
the PR description; it does not include the separate total-context or token-copy fixes.
