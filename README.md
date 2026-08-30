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

1. Sign in directly in the launcher's private embedded ChatGPT browser. If the account requires a
   passkey or advanced browser security, explicitly choose **Passkey sign in** instead. The launcher
   starts a deterministically selected supported Chrome/Chromium executable with a new launcher-owned
   temporary profile as a normal browser. Complete sign-in, confirm that Temporary Chat is ready,
   return to the launcher, and choose **I'm signed in — Continue**. The launcher closes only that
   dedicated browser, reopens its isolated profile through a private debugging pipe with networking
   blocked, and extracts only allowlisted ChatGPT/OpenAI state. Electron then independently proves
   the exact Temporary Chat and server session before the temporary profile and transfer files are
   removed.
2. Run the browser smoke test.
3. Press **Install models**, restart Codex once, and select a **ChatGPT Web — …** model.

The launcher detects the current account's ChatGPT controls during setup: Free/Go accounts expose
only Luna, while Pro appears only when the signed-in account exposes it. The separate **MCP** page
is optional and guides the full-harness setup without terminal commands.

The packaged launcher normally keeps sign-in and model turns in its embedded browser, so it needs no
installed browser, model API key, system Node/Bun, or project-managed browser download. The optional
passkey handoff uses the configured supported Chrome/Chromium executable exactly, or the same
platform Google Chrome default that setup will persist when none is configured. It never opens the
system default browser or reuses a normal browser profile.

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
| **Browser-only** | Free/Go: Luna; Plus: Instant–High; Pro: adds Extra High and Pro | No; Codex shows a warning | None by default |
| **Full harness** | Free/Go: Luna; Plus: Instant–High; Pro: adds Extra High and Pro | Yes for every listed effort, including Pro | OpenAI tunnel + ChatGPT connector |

Every picker entry has one fixed ChatGPT mode. Codex still displays its built-in Effort and Speed
rows, but changing them cannot silently change the selected browser model. In Full mode every
available effort receives the same turn-bound MCP capability. Pro has no separate restriction or
reduced tool contract. The optional passkey fallback is independent of mode and requires the
installed supported Chrome/Chromium executable described above.

## Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

> [!WARNING]
> Create a **new** connector named **Codex Native2** and set its permissions to
> **Allow all actions**. Do not rename, refresh, or reuse an older **Codex Native** connector:
> ChatGPT caches the public MCP contract by connector identity, and **Allow low-risk actions**
> blocks commands and patches before they reach the Codex harness.

1. Finish the required launcher setup.
2. Open **MCP** in the launcher. Create the Tunnel and a regular API key on the same OpenAI account
   that will use the ChatGPT connector; creating the key is free and does not consume model API
   credits.
3. Paste the Tunnel ID and API key, then press **Connect harness**.
4. Enable **Developer Mode** in ChatGPT settings. Create a **new** connector using **Tunnel**, select
   that exact Tunnel, set **Authentication** to **None**, and name it exactly **Codex Native2**.
5. If an older **Codex Native** connector exists, leave it untouched. Do not rename or refresh it:
   ChatGPT caches the public MCP contract by connector identity, and this release uses a new direct
   turn-token contract. Under **Permissions** on **Codex Native2**, choose **Allow all actions**;
   **Allow low-risk actions** blocks commands and patches before they reach this runtime. The outer
   Codex harness still enforces its sandbox and approvals.
6. Run **Verify runtime**. It selects **Codex Native2** exactly. If only **Codex Native** is found,
   verification fails with an explicit migration error instead of accepting the legacy connector.

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
- Browser state and the passkey flow's short-lived transfer files are sensitive login artifacts.
  Browser control stays on a launcher-owned child-process debugging pipe rather than a TCP listener,
  but the profile and transfer files remain inside the current OS user's trust boundary. Never share
  the launcher profile, and use passkey sign-in only on a trusted workstation.
- Passkey and identity-provider interaction occurs only in the normal browser phase. The later
  managed capture phase blocks external networking and does not attempt to disguise automation;
  Electron is the first component to accept or reject the imported session.
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
Responses daemon or changes Codex. Optional Full setup starts and supervises only its isolated MCP
tunnel, using the distinct ChatGPT connector name `Codex Native2 DEV`.

`dev:chat` is a named, persistent synthetic outer-Codex harness. It executes the current working
tree through that isolated launcher browser, Temporary Chat, prompt compiler, Responses parser, and
compaction handlers. Optional Full setup also exercises the MCP connector and broker; tool effects
are explicit simulation receipts. Browser-only chats expose no outer tools. It does
not open a Responses listener, change `openai_base_url`, stop the live daemon, or claim port 17841.
Run it without a message for `/status`, `/fill 30000`, `/compact`, `/model`, and `/reset` commands.
Sign in and initialize the profile once inside the window labelled **DEV**. Configure optional Full
harness only for simulated tool rounds; its launcher keeps the DEV tunnel ready while named chats
attach their broker on demand. Production credentials and the `Codex Native2` connector are never
reused implicitly. See
[DEV chat harness](docs/dev-chat.md).

- [Architecture](docs/architecture.md)
- [DEV chat harness](docs/dev-chat.md)
- [Security model](docs/security-model.md)
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
