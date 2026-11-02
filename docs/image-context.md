# Image working sets in automatic Full mode

Automatic Full-mode turns with a native thread identity archive supplied images locally, scoped to that thread. Image IDs are stable content digests; repeated copies in one prompt share an attachment. The latest image-bearing user message replaces the working set, while text-only follow-ups retain it. Tool-result images remain usable. Existing retained-conversation suffix transport avoids uploading unchanged history again; a fresh browser conversation receives the selected set again.

Historical images outside the working set become explicit placeholders in the browser projection, not in canonical Codex history. The model must not infer their contents. Captions are excerpts of the original text, not generated descriptions.

The existing `codex_tool_call` accepts the reserved `codex.image_context` operation when the current broker-bound environment owns an image archive. Its structured arguments are:

- `action`: `list`, `get`, `add`, or `replace`.
- `ids`: up to ten image IDs. `get` returns originals; `add` and `replace` also update subsequent prompts. Empty `replace` clears the set.
- `offset` and `limit`: paginate archive metadata (default 20, maximum 50).

Selected embedded PNG/JPEG/WebP/GIF images are returned through MCP. Remote URLs are never fetched by the archive; unavailable formats explicitly request reattachment. Oversized selected sets fail explicitly rather than silently dropping comparison images.

Archive files are private JSON under the runtime `image-context` directory, keyed by a digest of the thread ID, and survive daemon restarts/compaction. Each archive is capped at 100 MiB; it does not expire automatically. This is local screenshot data: do not include it in commits or diagnostics exports. Removing an archive makes its old images unavailable. Manual Zero Risk and browser-only mode retain their existing transport.

Limitations: removing an image from the working set does not erase it from an already open ChatGPT conversation. A connector retrieval also adds image content to that conversation; the model should request only needed originals. The feature does not infer task boundaries or resolve ambiguous phrases such as “the previous screenshot”; it exposes explicit selection instead.
