# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the launcher's private Electron browser
profile, the selected ChatGPT workspace, OpenAI's tunnel service, and the exact MCP connector they
created. During explicit passkey sign-in, the boundary temporarily also includes the selected
Chrome/Chromium executable, its launcher-owned profile, and the private transfer state. Repository
contents, tool output, websites, prompt text, and unrelated browser profiles are untrusted data.

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

The launcher's persistent Electron partition can authorize ChatGPT access. During passkey sign-in,
the temporary Chrome/Chromium profile and serialized transfer also contain login state until their
required cleanup completes. These artifacts remain under the current OS user's private
application-data directory and are never copied into a daemon prompt or runtime descriptor. Never
sync, upload, attach, or commit them. On suspected exposure, sign out or revoke the ChatGPT session
from the launcher.

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

The explicit passkey flow performs credential entry in a normal Chrome/Chromium process with no
debugging transport. The user then selects the launcher's continuation action, which travels only
over the authorized CLI child's inherited stdin and asks that helper to close its exact normal
browser child. Manual browser closure remains supported. After the process exits, the helper
reopens only its isolated profile over Playwright's inherited remote-debugging pipe. It never
exposes a browser-level TCP debugging listener. The temporary profile and transfer state are still
sensitive files inside the current OS user's trust boundary and must be removed before the handoff
can report success.

The post-login capture process may report `navigator.webdriver=true`, so every request in that
managed surface is fulfilled locally. No ChatGPT or identity-provider endpoint sees it. The
launcher does not hide the automation signal, downgrade authentication, or copy a normal browser
profile. The capture marker proves only that isolated profile extraction completed; Electron's
subsequent server-session check is the authoritative authentication proof.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow and completion requires stable
completed-turn evidence. UI drift fails the turn; it never chooses another model, starts another
transport, or returns a fabricated success.

### Login-state isolation and passkey transfer

Embedded login is the default: identity-provider navigation and model turns remain in one private
Electron partition. The passkey fallback runs only after the user explicitly selects it. A
configured absolute supported Chrome/Chromium executable is used exactly and is never silently
substituted; without one, the launcher uses the same platform Google Chrome default that setup will
persist instead of opening the system default browser.

The launcher creates a user-private transfer directory and a new owned browser profile; it never
inspects or reuses a normal browser profile. It first starts that profile as a normal browser with
no debugging transport. The user completes the passkey challenge, confirms Temporary Chat is
ready, returns to the launcher, and explicitly continues; manually quitting the dedicated browser
also advances the flow. The authorized CLI helper closes only its exact browser child and waits for
process exit before Playwright reopens the same profile through a private remote-debugging pipe.
The managed capture browser is headless and all networking is intercepted locally. A locally
fulfilled `https://chatgpt.com` document exposes only the profile-backed local storage needed for
serialization; no online authentication claim is made. The helper sanitizes the state, closes the
capture process, and removes the profile before capture completes.

The launcher bounds and validates the serialized state before import. It retains only
ChatGPT/OpenAI-domain cookies with representable attributes, rejects an empty allowed cookie set,
drops partitioned cookies rather than flattening them, and imports local storage only from
`https://chatgpt.com`. Third-party identity-provider state is not imported. Electron's existing
partition is cleared first, then the launcher independently requires the exact Temporary Chat,
visible composer, and valid server session in Electron. The transfer directory is removed before
success is reported. Invalid or oversized state, a partial import, failed embedded proof, or failed
cleanup fails the operation, attempts to clear or tear down partial Electron state, and never marks
the launcher session authenticated.

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
- The dedicated system-browser profile is created only for explicit passkey sign-in and uses
  ordinary browser networking. The interactive provider flow is not protected by a host allowlist;
  only the state later admitted to Electron is domain/origin allowlisted.
- The embedded browser connects to ChatGPT, identity providers used by normal embedded sign-in, and
  user-authorized attachment URLs through normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
