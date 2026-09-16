<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.7/codex-web-gpt-5.0.7-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.7/codex-web-gpt-5.0.7-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.7/codex-web-gpt-5.0.7-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.7/codex-web-gpt-5.0.7-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">What’s new</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex’s native model picker—with ChatGPT Web’s separate usage limits, without spending your Work or Codex quota. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your Codex task, so you can keep working as the context grows.

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Accounts with reasoning controls → **Instant–High**, plus **Extra High** and **Pro** when available. The launcher detects what your account can use.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models**, start Codex with `codex --profile gpt`, and choose a **ChatGPT Web — …** model. Plain `codex` keeps the base configuration. See [profile setup](README.md#codex-profiles-and-orca) for preserving the base config and resolving Orca account paths.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `Codex Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic model entries each select a fixed ChatGPT mode; Codex’s Effort and Speed rows do not override it.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window, or
> up to 270,000 tokens with experimental **3× context** enabled, with native Codex compaction
> supported throughout.

1. Finish the required setup, open **MCP**, create the Tunnel and regular API key, then press
   **Connect harness**.
2. Enable ChatGPT **Developer Mode** and create a new Tunnel connector named exactly
   **Codex Native2**, with **Authentication: None** and **Allow all actions**.
3. Run **Verify runtime** to confirm that **Codex Native2** is attached and available.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

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

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

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

Temporary Chat is a [ChatGPT privacy mode](https://help.openai.com/en/articles/8914046-temporary-chat-faq); prompts are still processed by OpenAI.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal Codex route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

## Codex profiles and Orca

These instructions also apply to AI agents installing or repairing this integration. Resolve paths on
the target machine; do not copy another user's home directory, account ID, or installed runtime
path. The production integration manages `gpt.config.toml`, while the isolated **DEV** launcher
continues to manage `config.toml` inside its own sandboxed Codex home.

### Keep the base configuration and Web profile separate

| Launch command | Configuration | Routing |
| --- | --- | --- |
| `codex` | `<CODEX_HOME>/config.toml` | Existing native/provider configuration |
| `codex --profile gpt` | Base config with `<CODEX_HOME>/gpt.config.toml` layered over it | Local Web bridge |

Use a Codex CLI whose `codex --help` describes `--profile` as loading
`$CODEX_HOME/<name>.config.toml` (confirmed with Codex CLI 0.154.0). This is a separate file, not a
`[profiles.gpt]` table in the base config. An IDE or terminal launch preset must pass
`--profile gpt` to opt in; selecting a Web model alone does not select the profile.

**Install models** targets the launcher's own `CODEX_HOME`, falling back to `~/.codex`. It does
not automatically configure every Orca account. Preserve the base config's model, provider,
catalog, MCP, hooks, and other user settings. Put Web route overrides in `gpt.config.toml` only.

For a manually configured profile using the OpenAI provider, the relevant top-level settings
look like this. Merge them into the existing file; do not replace the entire file:

```toml
# <resolved CODEX_HOME>/gpt.config.toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:17841/v1"
```

`17841` is the default, not a fixed requirement. Read the running bridge's configured `host`
and `port` and use its actual URL. Choose a Web model available to the signed-in account.
If an existing profile uses a custom provider such as `chatgpt-web`, preserve that provider
and update its `base_url` instead of blindly replacing it. Let the integration installer manage
its protocol settings and interrupt hook; the example above shows only the route settings.

If the base config has a native-only `model_catalog_json`, override it in the Web profile with
the actual local path to a catalog containing the desired Web and native models. Preserve
existing Astra (`gpt-6-astra`), Sol (`gpt-5.6-sol`), and Luna (`gpt-5.6-luna`) entries and their
full metadata when merging catalogs. Do not copy another PC's absolute catalog path. Native
model requests through the Web profile are forwarded to the native Codex backend.

Bigger Context, the dynamic `/models` response, and local profile catalogs use the same context
limit calculation. Setup and bridge startup refresh only the Web context fields in catalogs
referenced by `gpt.config.toml` in the launcher's Codex home and registered Orca homes routed to
this bridge. Native rows, model ordering, and profile settings are preserved. Automatic compaction
starts at 95% of the usable task budget: for a Pro account, 90,250 tokens with Bigger Context off
and 270,750 with it on. Restart Codex and resume the existing session after changing the setting;
already-running Codex processes may retain the old catalog. Before disabling Bigger Context on
a long conversation, compact it while the larger window is still available.

### Find the active Orca account's home

Run the following **inside the Orca terminal that will start Codex**:

```bash
printf '%s\n' "${CODEX_HOME:-$HOME/.codex}"
```

On Windows PowerShell:

```powershell
$codexTargetHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path $env:USERPROFILE '.codex'
} else {
    $env:CODEX_HOME
}
$codexTargetHome
```

Resolve the result to an absolute path and verify it belongs to the selected account. Orca may
use a layout such as `<Orca application-data directory>/codex-accounts/<account-id>/home`.
The application-data root and account ID vary by machine, platform, and account; this layout is
illustrative, not a path to paste. A terminal outside Orca can report a different home. If Orca
does not expose the expected environment, inspect its selected account and terminal launch
configuration before editing files.

Create or merge `gpt.config.toml` in that resolved account home, preserving its `config.toml`.
Reuse the working Web profile's settings only after resolving catalog and hook executable paths
on this machine. Preserve Orca-owned `hooks.json` and account authentication files. Set the
Orca Codex launch command/preset to include `--profile gpt`, or run `codex --profile gpt` in
that terminal. Repeat for each account the user wants to enable.

### Register Orca homes for session resume

The bridge can run under the launcher's home while Orca stores Codex rollouts under a separate
account home. Profile routing and rollout discovery are separate: both must be configured.

Resolve the running launcher's bridge home from `CODEX_CHATGPT_WEB_HOME`, defaulting to
`~/.codex-chatgpt-web`. This is different from `CODEX_HOME`; an unrelated terminal's environment
does not establish which home the desktop launcher uses. Merge the selected Orca account's
absolute Codex home into `<bridge-home>/runtime/codex-homes.json`:

```json
{
  "version": 1,
  "homes": ["<resolved absolute Orca CODEX_HOME>"]
}
```

Replace the placeholder before saving. Preserve existing registrations, deduplicate paths,
and register only the local accounts intended to use this bridge. JSON does not expand `~`,
`$HOME`, or environment variables; use absolute paths visible to the bridge process, including
when working with WSL. The current runtime reads this file when recovering rollout context;
there is no CLI command that automatically registers Orca accounts. Registration allows the
bridge to locate native turn context after a conversation is resumed; it does not replace the
thread/turn ownership checks. Never repair a missing `cwd` by guessing a project directory or
using another account's unrelated session.

### Existing installations and completion checks

An older installation may still have its Web route in `config.toml` and a journal at
`<bridge-home>/codex/integration-journal.json` targeting that file. The new installer rejects a
journal targeting a different config; merely changing `CODEX_HOME` or renaming the journal's
`configPath` is not a migration. Before upgrading, remove the old integration with the matching
build so its recorded settings are restored, then install the new profile integration. If
already upgraded, back up both configs and the journal and use the matching old integration
recovery/uninstall code to restore only its managed changes. Preserve unrelated edits. Do not
delete the journal first and leave the base config routed through the bridge.

One bridge installation has one integration journal. Keep its launcher-managed target home
stable; merge profiles into additional Orca homes as described above rather than repeatedly
running setup under different accounts against the same journal.

For an AI installer, completion means reporting the resolved target homes and changed files,
confirming that the base config retains its intended route, and checking that a new
`codex --profile gpt` session uses the bridge. For Orca, also resume that same session and check
that its working directory and tool access are retained. Do not claim these live checks passed
from a README edit alone. Source references:
[profile path selection](src/codex-integration-shared.ts),
[launcher home selection](launcher/electron/profile.cjs),
[journal validation](src/codex-integration-journal.ts), and
[registered rollout homes](src/adapters/chatgpt-web/thread-environment.ts).


## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Also by me: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — local, near-real-time custom voices for ChatGPT and Codex.
