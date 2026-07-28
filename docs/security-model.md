# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the dedicated browser login profile,
the selected ChatGPT workspace, and—only in full mode—OpenAI's tunnel service and the exact MCP
connector they created. Repository contents, tool output, websites, and prompt text are untrusted
data.

## Tool capability flows

1. The daemon accepts a Codex Responses turn on `127.0.0.1`.
2. It extracts `cwd`, workspace roots, sandbox policy, and the tool registry only from the native
   Codex wire envelope with matching turn metadata. A user-authored `<environment_context>` is not
   accepted as authority.
3. In `plus-tools` mode, the bridge creates a random per-turn nonce. ChatGPT may request only tools
   in the prompt's exact catalog using a terminal, nonce-bound JSON block. The parser validates the
   nonce, tool name, argument shape, and framing before Codex executes anything.
4. In `full` mode, the bridge instead creates a random, expiring turn token. The connector exchanges
   it once for an opaque binding; claims are idempotent for retry safety.
5. Either transport can request only a tool advertised by the active outer Codex turn. Codex
   remains responsible for its sandbox, approval, UI, command sessions, and tool results.
6. The capability or nonce is revoked when the turn completes, aborts, or expires. Pro remains
   read-only in every mode.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Unsupported model/effort/tool combinations fail explicitly.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees repository content and tool results that may contain hostile instructions.
`plus-tools` and `full` can invoke write and command tools. Use a trusted workspace and keep Codex
sandbox and approval settings appropriate. Automatic connector approval is off by default.

### Browser session theft

`storage-state.json` can authorize ChatGPT access. It is stored with user-only permissions. Windows
login uses a dedicated Chrome or Firefox profile and copies only `chatgpt.com` and `openai.com`
cookies into the automation state; the dedicated login profile is then removed. Never sync,
upload, attach, or commit the application home. On suspected exposure, sign out/revoke the ChatGPT
session and run `login` again.

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

The lifecycle endpoints are separate from the Responses surface. `/admin/drain` and
`/admin/resume` require a random bearer token stored in the user-only application config. Service
management uses them to reject new work and atomically prove that both the HTTP request and the
long-lived browser/tool loop are idle before stopping a process. The token does not turn loopback
into a hostile-local-process security boundary; it prevents accidental or unauthenticated lifecycle
control through ordinary requests.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow and completion requires stable
completed-turn evidence. UI drift fails the turn; it never chooses another model, starts another
transport, or returns a fabricated success.

### Cross-turn data leakage

Browser turns are serialized. Every outer Codex turn navigates to a fresh Temporary Chat page and
closes the prior page. Tool calls for that turn remain in the same ChatGPT response. The bounded
local continuation cache is private, expires, and exists only to implement Codex
`previous_response_id` replay. ChatGPT Web context compaction remains inside the active browser
response; the bridge does not fabricate or install a Codex history checkpoint.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The selected controlled browser connects to ChatGPT and user-authorized attachment URLs only
  through its normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/browser binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
