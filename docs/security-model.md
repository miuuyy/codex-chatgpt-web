# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the configured Chrome profile, the
selected ChatGPT workspace, OpenAI's tunnel service, and the exact MCP connector they created.
Repository contents, tool output, websites, and prompt text are untrusted data.

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

The dedicated `chrome-profile` can authorize ChatGPT access. It is stored with user-only
permissions, and cookies are never exported to the bridge. Never sync, upload, attach, or commit
the application home. On suspected exposure, sign out/revoke the ChatGPT session and run `login`
again.

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

Normal browser turns are serialized. Up to four independently routed Ultra turns may run
concurrently, but every outer Codex turn owns a distinct Temporary Chat target, CDP session,
capability binding, prompt, and response DOM. Its page closes in a `finally` path when the turn
settles. Ultra may separately ask the outer Codex harness for up to three collaboration agents;
the broker pins those agents to the configured native Codex model to prevent recursive Ultra
fan-out and removes any requested service-tier override. Tool calls for a browser turn remain in
that same ChatGPT response. The bounded local continuation cache is private, expires, and exists
only to implement Codex `previous_response_id` replay. ChatGPT Web context compaction remains inside
the active browser response; the bridge does not fabricate or install a Codex history checkpoint.

Ultra is experimental and explicitly opt-in. It can increase both collaboration-agent work and
request concurrency against one authenticated ChatGPT account. The user is responsible for account
limits, throttling, workspace policy, and compliance with OpenAI terms. The pool is bounded; it does
not retry to evade product limits, rotate accounts, change service tier, or bypass workspace
controls. ChatGPT may still throttle or reject concurrent turns.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- Chrome connects to ChatGPT and user-authorized attachment URLs only through its normal browser
  networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Chrome binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
