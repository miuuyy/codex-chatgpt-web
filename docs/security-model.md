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
3. It creates a random, turn-scoped token and embeds it in that one ChatGPT browser prompt.
4. Every Codex Native action presents that same turn token. The MCP handler idempotently claims an
   internal binding and immediately dispatches the requested action; the binding is never exposed
   to the model. Both handles are revoked when the turn completes, aborts, or expires.
5. MCP can request only a tool advertised by the active outer Codex turn. Codex remains responsible
   for its sandbox, approval, UI, command sessions, and tool result.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Unsupported model/effort/tool combinations fail explicitly.

The direct turn-token MCP schema is attached only through the `Codex Native2` connector identity.
The pre-v4 `Codex Native` connector is treated as legacy and is never selected as a fallback. This
prevents a cached legacy schema from being mistaken for the current capability contract.

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

### Login-state transfer

Platform passkeys and identity verification run only in the operating system's default browser
process with a dedicated temporary profile. The current login adapter requires a Chromium-compatible
default browser. The launcher does not treat opening that
browser as authentication evidence. A helper first proves a real ChatGPT Temporary Chat composer;
the launcher then imports only allowlisted ChatGPT/OpenAI cookies and ChatGPT local storage into its
private Electron partition and proves the composer again. Third-party identity-provider state is
not copied. Invalid or oversized state, a partial import, failed embedded verification, or failed
temporary-state cleanup clears the imported Electron state and fails closed.

### Cross-turn data leakage

Browser turns use at most five independent task-bound tabs in one private login partition. Every
outer Codex task owns a fresh Temporary Chat document and an exact launcher surface lease; chats are
never reused across tasks. Closing a running tab destroys its page and terminates that turn. The
five-tab limit bounds parallel account traffic. Tool calls remain in the same ChatGPT response. The
bounded local continuation cache is private, expires, and exists only to implement Codex
`previous_response_id` replay. ChatGPT Web context compaction remains inside the active browser
response; the bridge does not fabricate or install a Codex history checkpoint.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The dedicated system default-browser login profile connects to ChatGPT and its selected identity
  provider only during an explicit sign-in operation.
- The embedded browser connects to ChatGPT and user-authorized attachment URLs through normal
  browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
