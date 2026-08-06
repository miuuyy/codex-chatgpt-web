# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the launcher's private Electron browser
profile, the selected ChatGPT workspace, OpenAI's tunnel service, and the exact MCP connector they
created. Repository contents, tool output, websites, and prompt text are untrusted data.

## Full-mode capability flow

1. The daemon accepts a Codex Responses turn on `127.0.0.1`.
2. It extracts `cwd`, workspace roots, sandbox policy, and the tool registry only from the native
   Codex wire envelope with matching turn metadata. A user-authored `<environment_context>` is not
   accepted as authority.
3. It creates a random, expiring turn token and embeds it in that one ChatGPT browser prompt.
4. The connector exchanges the token once for an opaque binding. Claims are idempotent for retry
   safety; the capability is revoked when the turn completes, aborts, or expires.
5. MCP can request only a tool advertised by the active outer Codex turn. Codex remains responsible
   for its sandbox, approval, UI, command sessions, and tool result.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Unsupported model/effort/tool combinations fail explicitly.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees repository content and tool results that may contain hostile instructions. Full mode
can invoke write and command tools. Use a trusted workspace, keep Codex sandbox/approval settings
appropriate, and grant only intended connector actions. Automatic per-call approval is off by
default.

### Browser session theft

The launcher's persistent Electron partition can authorize ChatGPT access. It remains in the
current OS user's private application-data directory and is never copied into a daemon prompt or
runtime descriptor. Never sync, upload, attach, or commit it. On suspected exposure, sign out or
revoke the ChatGPT session from the launcher.

### Tunnel credential theft

The runtime key needs only Tunnels Read + Use. It is accepted through a hidden prompt or copied
from a file, stored with user-only permissions, referenced by file, and never placed in a command
argument or generated profile. Rotate it after suspected exposure.

### Same-user local process

The Responses endpoint is loopback-only, but it has no independent bearer secret because the
built-in Codex OpenAI provider cannot be configured with a bridge-specific credential while
preserving the native provider/task identity. Another process under the same OS user can reach the
port. Run on a trusted single-user account and treat local code execution as inside the trust
boundary.

The lifecycle endpoints are separate from the Responses surface. `/admin/drain`, `/admin/resume`,
`/admin/cancel-browser-turns`, and `/admin/shutdown` require a random bearer token stored in the
user-only application config. The launcher uses them to reject new work, prove that both the HTTP
request and long-lived browser/tool loop are idle, flush response state, and stop a process. The
token does not turn loopback into a hostile-local-process security boundary; it prevents accidental
or unauthenticated lifecycle control through ordinary requests.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow and completion requires stable
completed-turn evidence. UI drift fails the turn; it never chooses another model, starts another
transport, or returns a fabricated success.

### Task-context attachment integrity

Every browser turn requires exactly one in-memory task-context document. Normal, read-only, and
tool-capable turns bind a UTF-8 `codex-task-context.txt` file (`text/plain`), while context-compaction
turns bind a `codex-compaction-context.zip` archive (`application/zip`) built in memory. Both the
daemon and launcher-helper boundaries validate the exact per-variant filename, MIME type, envelope
version, and schema. A prepared prompt that omits the document, adds unexpected attachment fields,
duplicates the context inline, exceeds the ten-file message limit, or produces duplicate file names
fails before Send.

The stable repeated filename is safe because every outer task opens a fresh Temporary Chat and
attachment readiness is scoped to the current active composer form. The documents are uploaded from
memory and are not persisted in the workspace, repository, planning paths, or a durable temporary
file. Attachment mounting can replace the composer subtree, so the browser revalidates the current
bootstrap, exact file evidence, connector selection when applicable, and enabled Send control after
the upload completes.

### Cross-turn data leakage

Browser turns use independent task-bound tabs in one private login partition, with no fixed
application-level tab maximum. Every outer Codex task owns a fresh Temporary Chat document and an
exact launcher surface lease; chats are never reused across tasks. Closing a running tab destroys
its page and terminates that turn. Parallel traffic remains subject to machine resources and
ChatGPT account-side controls. Tool calls remain in the same ChatGPT response. The bounded local
continuation cache is private, expires, and exists only to implement Codex `previous_response_id`
replay. ChatGPT Web context compaction remains inside the active browser response; the bridge does
not fabricate or install a Codex history checkpoint.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The embedded browser connects to ChatGPT and user-authorized attachment URLs through normal
  browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
