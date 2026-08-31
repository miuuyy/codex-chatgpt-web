<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>Use ChatGPT Web (including Pro) as native Codex models.</strong><br>
  Change the model tier, save your workflow.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="TROUBLESHOOTING.md">Troubleshooting</a> · <a href="SECURITY.md">Security</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Free and Go accounts get **ChatGPT Web — Luna** in Codex's native model picker. Accounts that
expose the reasoning selector keep **Instant**, **Medium**, **High**, **Extra High**, and **Pro** as
their subscription allows. The bridge sends the current compiled Codex task context to a fresh
ChatGPT Temporary Chat, attaches images, and streams visible reasoning, tool activity, and Markdown
back into the same Codex task.

<p align="center">
  <img src="assets/demo.gif" alt="A live ChatGPT Web turn using the native Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──embedded browser──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

Codex keeps the native task, context lifecycle, UI, and tool harness. The local Responses bridge
routes only the selected model task through a task-bound ChatGPT Temporary Chat; in full mode, MCP
connects ChatGPT back to the tools of that same Codex task until its next compaction boundary.

> [!TIP]
> I also built **[ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice)**, a local
> app that changes the ChatGPT/Codex voice in near real time. It never touches your account, browser
> session, or ChatGPT requests, so using it carries no account-blocking risk. If you like my work,
> give it a try.

## Highlights

- **Native Codex models.** ChatGPT Web runs from Codex's model picker while the original task UI,
  context lifecycle, streaming, tracing, and tool presentation stay intact.
- **The full Codex harness over MCP.** Full mode gives every effort exposed by the signed-in account,
  including Pro, the active task's filesystem, shell, images, approvals, and configured tools/apps.
- **Continuous task sessions and native compaction.** Sequential messages reuse one task-bound
  Temporary Chat. At the context boundary, the retained agent writes the checkpoint before Codex
  starts a clean chat; if that chat was closed, canonical Codex history supplies the fallback.
- **One cross-platform launcher.** The macOS, Windows, and Linux app owns sign-in, model setup, MCP
  guidance, health checks, safe diagnostics, and up to five visible task-bound browser tabs.
- **Fail-closed behavior.** Missing models, tools, or changed ChatGPT UI produce explicit errors
  instead of silently switching route or capability. End-to-end coverage is documented in
  [release validation](docs/release-validation.md).

Temporary Chat is a ChatGPT privacy mode, not anonymity or local-only inference: prompts are still
processed by OpenAI and are subject to the account's settings and OpenAI's
[Temporary Chat policy](https://help.openai.com/en/articles/8914046-temporary-chat-faq). This project
is unofficial; users remain responsible for complying with applicable OpenAI terms and workspace
policies.

## Quick start

Install or update the desktop launcher. To update or repair an existing installation, quit the
launcher and run the same command again; it replaces the application and embedded runtime while
preserving the ChatGPT profile and launcher configuration.

**macOS or Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

Then complete the three checks in the app:

1. Sign in directly in the launcher's embedded ChatGPT browser. Login pages and identity-provider
   windows stay inside the same launcher-owned private browser profile; no session is copied between
   browsers.
2. Run the browser smoke test.
3. Press **Install models**, restart Codex once, and select a **ChatGPT Web — …** model.

The launcher detects the current account's ChatGPT controls during setup: Free/Go accounts expose
only Luna, while Pro appears only when the signed-in account exposes it. The separate **MCP** page
is optional and guides the full-harness setup without terminal commands.

The packaged launcher keeps sign-in and ChatGPT model turns in its embedded browser. It needs no
browser extension, model API key, installed Chrome/Chromium, system Node/Bun, or project-managed
browser download.

**Run from source**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

## Modes

| Mode | Models | Local Codex tools | Extra setup |
| --- | --- | --- | --- |
| **Browser-only** | Free/Go: Luna; Plus: Instant–High; Pro: adds Extra High and Pro | No; Codex shows a warning | None |
| **Full harness** | Free/Go: Luna; Plus: Instant–High; Pro: adds Extra High and Pro | Yes for every listed effort, including Pro | OpenAI or Cloudflare tunnel + ChatGPT connector |

Every picker entry has one fixed ChatGPT mode. Codex still displays its built-in Effort and Speed
rows, but changing them cannot silently change the selected browser model. In Full mode every
available effort receives the same turn-bound MCP capability. Pro has no separate restriction or
reduced tool contract.

## Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through either the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client) or an existing Cloudflare named
tunnel. Both are outbound connections and require no router forwarding. The Cloudflare option is
available in the production desktop launcher; the repository DEV harness continues to use OpenAI
Tunnel because it intentionally has no Responses HTTP listener.

> [!WARNING]
> Choose a connector name in the launcher, create a connector with that exact name, and set its
> permissions to **Allow all actions**. If an existing connector needs the current MCP authentication
> contract, open it and choose Connect or Reconnect. If neither action is shown, edit it using the
> launcher fields, save it, and connect again; deletion is not normally required.

1. Finish the required launcher setup.
2. Open **MCP** in the launcher and enter the connector name you want to use.
3. Choose one tunnel provider:
   - **OpenAI Tunnel:** create a Tunnel and a regular API key on the same OpenAI account that will
     use the ChatGPT connector, paste both values, and press **Connect harness**. Creating the key
     is free and does not consume model API credits.
   - **Cloudflare named tunnel:** install `cloudflared`, select its executable and a YAML config,
     then choose one exact hostname from that config and press **Connect harness**. The launcher
     automatically checks `~/.cloudflared/config.yml` first. It creates a private temporary config
     that routes only a random MCP URL path to the current loopback port; it never edits the source
     YAML and removes the temporary file when the tunnel stops.
4. Enable **Developer Mode** in ChatGPT settings and create or update a connector with the exact name
   shown by the launcher. For OpenAI Tunnel, choose **Tunnel** and the configured tunnel. For
   Cloudflare, create a custom MCP connector using the complete URL displayed by the launcher. Set
   **Authentication** to **OAuth**, paste the displayed **Registration URL** into Advanced OAuth
   settings, keep DCR and token endpoint authentication **None**, then enter the launcher's local
   authorization passphrase on the consent page. Possessing the URL alone does not grant access.
5. Under **Permissions**, choose **Allow all actions**; **Allow low-risk actions** blocks command
   calls before they reach this runtime.
6. Run **Verify runtime**. Verification selects the configured connector name exactly and does not
   fall back to a legacy connector.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

## Operations

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings can also cancel a retained browser turn or remove the Codex integration before uninstall.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

## Limitations and security

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Development

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` starts a second launcher profile under `~/.codex-chatgpt-web-dev`: separate Electron
state, browser cookies/login, ChatGPT account, configuration, sandboxed `CODEX_HOME`, chats,
diagnostics, broker, and tunnel profile. It can run beside the normal launcher and never starts a
Responses daemon or changes Codex. Optional Full setup starts and supervises only its isolated
OpenAI MCP tunnel, using a separately configurable connector name; it does not reuse production
Cloudflare settings.

`dev:chat` is a named, persistent synthetic outer-Codex harness. It executes the current working
tree through that isolated launcher browser, Temporary Chat, prompt compiler, Responses parser, and
compaction handlers. Optional Full setup also exercises the MCP connector and broker; tool effects
are explicit simulation receipts. Browser-only chats expose no outer tools. It does
not open a Responses listener, change `openai_base_url`, stop the live daemon, or claim port 17841.
Run it without a message for `/status`, `/fill 30000`, `/compact`, `/model`, and `/reset` commands.
Sign in and initialize the profile once inside the window labelled **DEV**. Configure optional Full
harness only for simulated tool rounds; its launcher keeps the DEV tunnel ready while named chats
attach their broker on demand. Production credentials and the production connector are never reused
implicitly. See
[DEV chat harness](docs/dev-chat.md).

- [Architecture](docs/architecture.md)
- [DEV chat harness](docs/dev-chat.md)
- [Security model](docs/security-model.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md)

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

## Disclaimer

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.
