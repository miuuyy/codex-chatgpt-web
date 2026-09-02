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
   internal binding plus a request-scoped activity lease and immediately dispatches the requested
   action; neither internal handle is exposed to the model. The lease is settled only after the MCP
   handler finishes, including inventory calls that need no outer Codex tool.
5. MCP can request only a callable tool advertised by the active outer Codex turn. The unrestricted
   raw orchestration `exec` gateway remains available in Full mode. Before caller-authored
   JavaScript runs, the bridge wraps its tool registry with a transparent proxy that enforces the
   exact 10-second `wait_agent` polling contract and prevents recursive raw `exec`. The generic
   inventory/call pair also provides a structured exact-name path. Codex remains responsible for
   its sandbox, approval, UI, command sessions, and tool result.
6. Before a Codex tool batch is dispatched, the browser records and acknowledges the current answer
   projection. Completion stays blocked while the tool is unresolved and then requires a new stable
   final-answer projection after that causal boundary. A two-phase broker fence then rereads the DOM
   and commits completion only if the activity revision stayed unchanged with no active invocation;
   a concurrent claim makes the candidate lose, while a claim after commit receives an explicit
   terminal rejection. Recent MCP activity may suppress a false DOM-health failure but never adds
   an idle delay to a successful completion.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Every available effort uses the same MCP contract. An unavailable account route, missing
connector, or missing outer tool fails explicitly instead of becoming an effort-specific exception.

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
`/admin/cancel-turn`, `/admin/cancel-turns`, and `/admin/shutdown` require a random bearer token stored in the
user-only application config. The launcher uses them to reject new work, prove that both the HTTP
request and long-lived browser/tool loop are idle, flush response state, and stop a process. The
token does not turn loopback into a hostile-local-process security boundary; it prevents accidental
or unauthenticated lifecycle control through ordinary requests.

### Native V2 subagent message confidentiality

Native MultiAgent V2 normally marks delegation messages for provider-private encryption. When the
user selects the **Native** subagent protocol, this proxy deliberately removes that marker only for
the `message` fields of `spawn_agent`, `send_message`, and `followup_task`, then marks the returned
calls for Codex's plaintext delivery path. This is what lets native and ChatGPT Web agents delegate
to each other, but it also means those delegation prompts can appear as plaintext in the trusted
local Codex history and rollout files. Compatibility V1 also uses readable cross-agent messages.
Use either mode only on a trusted workstation, and do not place secrets in subagent prompts that
should not be present in local task history.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow; Full-mode completion requires
stable completed-turn evidence and, after tools, a new final-answer projection. UI drift fails the
turn; it never chooses another model, starts another transport, or returns a fabricated success.

### Login-state isolation

The launcher keeps ChatGPT login, identity-provider navigation, and model turns in one private
Electron partition. Allowed login popups are adopted into an in-launcher `WebContentsView` that
shares that partition; unrelated external links remain outside it. A visible composer alone is not
authentication evidence: the launcher also requires a valid server session and an exact Temporary
Chat URL before setup can continue. No cookies, local storage, or browser profile are copied from an
external browser.

### Cross-turn data leakage

Browser turns use at most five independent task-bound tabs in one private login partition. Every
outer Codex task owns an exact launcher surface lease and retains its Temporary Chat only across
sequential messages in the same model/effort/compaction epoch; chats are never reused across tasks.
Closing a running tab destroys its page and terminates that turn. The five-tab limit bounds parallel
account traffic. Tool calls remain in the same ChatGPT response. The
bounded local continuation cache is private, expires, and exists only to implement Codex
`previous_response_id` replay. Full-mode context compaction accepts a checkpoint only through its
one-shot MCP control capability in the exact retained source chat. If that chat no longer exists, a
fresh tool-free Temporary Chat receives the canonical Codex history; the bridge never parses ordinary
assistant prose as a structured handoff.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The embedded browser connects to ChatGPT, the selected identity provider during explicit sign-in,
  and user-authorized attachment URLs through normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
