<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>Use ChatGPT Web (including Pro) as native Codex models.</strong><br>
  Change the model tier, save your workflow.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20Intel-black?logo=apple" alt="macOS arm64 and Intel">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
  <img src="https://img.shields.io/badge/Windows-coming_soon-0078d4?logo=windows11" alt="Windows support coming soon">
</p>

Pick **ChatGPT Web — Instant**, **Medium**, **High**, **Extra High**, **Ultra**, or **Pro** in
Codex's native model picker. The bridge sends the complete Codex task context to a fresh ChatGPT
Temporary Chat, attaches images, and streams visible reasoning, tool activity, and Markdown back
into the same Codex task.

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web running inside the native Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──loopback DevTools──▶ ordinary Chrome ──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

## Highlights

- **Native Codex harness.** This is the same model-picker, task history, context lifecycle,
  approvals, sandbox, streaming, tracing, and tool UI you already use in Codex—not a second chat
  client. Like OpenCodex, it changes the model backend while preserving the native workflow.
- **Local-first task sessions.** Codex remains the source of truth for task history on your
  computer. Every browser turn starts in a fresh ChatGPT Temporary Chat and receives the complete
  accumulated Codex context, so browser chats are not reused across tasks or added to normal
  ChatGPT history.
- **The full Codex harness over MCP.** In full mode, Instant through Ultra can use the active
  Codex task's filesystem, shell, images, approvals, and configured tools/apps through MCP. Calls
  and real results stay inside the same browser response—nothing is simulated as text.
- **Real parallel Ultra orchestration.** The manually selected Ultra route uses Extra High as its
  coordinator and may ask the outer Codex harness to fan out to three native collaboration agents.
  The bridge pins those agents to its configured native Codex model so they cannot recursively
  inherit Ultra, while leaving the service tier at the user's default. Separately, the bridge can
  overlap up to four Ultra browser turns, each in its own Temporary Chat page. Normal routes stay
  exclusive.
- **Pro stays useful.** Pro is the one exception: ChatGPT's current Pro mode does not expose the
  custom MCP connector this bridge needs. Its native capabilities, including web search and
  research, remain available. Gather local workspace context with Instant through Extra High,
  switch to Pro, and Pro receives the complete accumulated Codex task for deeper analysis.
- **Fail-closed and manually tested.** Model selection, long inline context, images, streaming,
  visible trace, compaction, native tool rounds, cancellation, and Pro were exercised end-to-end on
  macOS. UI drift and missing capabilities produce explicit errors rather than silent fallbacks.

Temporary Chat is a ChatGPT privacy mode, not anonymity or local-only inference: prompts are still
processed by OpenAI and are subject to the account's settings and OpenAI's
[Temporary Chat policy](https://help.openai.com/en/articles/8914046-temporary-chat-faq). This project
is unofficial; users remain responsible for complying with applicable OpenAI terms and workspace
policies.

## Quick start

Browser-only mode needs macOS, Google Chrome, and a ChatGPT account. It does not need an API key,
tunnel, system Node/Bun installation, OpenCodex, Playwright, or a downloaded automation browser.

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --browser-only --acknowledge-unofficial
```

Sign in through the one Chrome window opened by setup, restart Codex once, and select a
**ChatGPT Web — …** model. Pro appears only when it is available on the authenticated account.
Normal use starts automatically after macOS login and does not require another terminal command.

## Modes

| Mode | Models | Local Codex tools | Extra setup |
| --- | --- | --- | --- |
| **Browser-only** | Instant–Extra High, Pro | No; Codex shows a warning | None |
| **Full harness** | Instant–Ultra, Pro | Instant–Ultra: yes; Pro: read-only | OpenAI tunnel + ChatGPT connector |

Every picker entry has one fixed ChatGPT mode. Codex still displays its built-in Effort and Speed
rows, but changing them cannot silently change the selected browser model. Pro receives the full
context already collected by Codex, but ChatGPT Pro cannot initiate local MCP/tool calls.

> [!WARNING]
> **Ultra is experimental and explicitly opt-in.** It may fan out to three native Codex agents and
> permit up to four simultaneous ChatGPT Web turns against one account. You are responsible for
> account limits, throttling, workspace policy, and compliance with OpenAI terms. Ultra does not
> rotate accounts, change service tiers, or retry to evade limits.

The proxy keeps Codex's built-in `openai` provider and live model catalog. It forwards the official
catalog unchanged and appends only its ChatGPT Web entries, so native models, task history,
approvals, sandboxing, and tool results remain owned by Codex.

## Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

1. Create a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a runtime key with **Tunnels Read + Use** in [Platform API key settings](https://platform.openai.com/settings/organization/api-keys).
3. Install and import the key:

   ```bash
   curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ~/.local/bin/codex-chatgpt-web tunnel key-import
   ```

4. Run setup with your tunnel id:

   ```bash
   ~/.local/bin/codex-chatgpt-web setup --full \
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
     --acknowledge-unofficial
   ```

5. While `doctor` reports ready, attach that tunnel to a ChatGPT connector named `Codex Native`
   in [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors), scan its tools, set
   the intended action permissions, and restart Codex once.

Write/modify actions require a ChatGPT workspace and admin policy that permit them. OpenAI
currently documents those actions for Business and Enterprise/Edu workspaces; personal Pro is
limited to read/fetch MCP permissions. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

## Operations

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web tunnel status        # full mode
codex-chatgpt-web browser check
codex-chatgpt-web login                # refresh an expired ChatGPT session
codex-chatgpt-web uninstall --yes
```

Setup stores private state under `~/.codex-chatgpt-web`, installs versioned launchd services, and
journals the previous Codex route so uninstall can restore it. It refuses to replace a different
route unless `--replace-codex-route` is explicit, and refuses to stop or update while a task is
still active.

If you stop a Codex task between native tool rounds, no Responses request remains on which Codex
can signal cancellation. Abort the retained browser turn without stopping the daemon, then retry
the update:

```bash
codex-chatgpt-web service cancel-turns
```

## Limitations and security

- This is unofficial browser control, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- The dedicated ordinary-Chrome profile is a sensitive login artifact. Cookies remain inside
  `~/.codex-chatgpt-web/chrome-profile` and are never exported; never share or commit that directory.
- Chrome DevTools listens on a fixed loopback-only port while this profile is open. Any process
  running as the same local user can control that dedicated profile, so do not use it for unrelated
  browsing.
- The Responses listener is loopback-only, but another process running as the same local user can
  reach it. Use a trusted single-user workstation.
- Normal browser turns are serialized. Up to four independently routed Ultra turns may use isolated
  pages concurrently. ChatGPT account limits can still throttle concurrent work.
- Managed background installation currently supports macOS only.
- Codex Desktop hardcodes Pro's wire effort as **Ultra** and always shows a **Standard** speed row.
  Those controls do not alter the fixed ChatGPT Web model. Renaming them would require patching the
  signed Codex app.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs dependency auditing, strict TypeScript checks, harness/MCP/config tests, and a
relocatable runtime smoke test. The browser transport uses a dedicated visible ordinary-Chrome
profile with a fixed loopback DevTools port and never enables WebDriver mode.

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Contributing](CONTRIBUTING.md)

## Credits and disclaimer

Portions of the Responses translation, Codex catalog integration, and browser harness were adapted
from [OpenCodex](https://github.com/lidge-jun/opencodex) under the MIT license. See
[third-party notices](LICENSES/NOTICE.md).

This project is experimental, independent software. It is not affiliated with or endorsed by
OpenAI, and it must not be used to evade usage limits or access controls. Review OpenAI's current
[Terms of Use](https://openai.com/policies/terms-of-use/) and
[Services Agreement](https://openai.com/policies/services-agreement/) before public distribution.
