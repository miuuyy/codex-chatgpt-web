# Microsoft 365 Copilot Web provider

This fork adds a separate `copilot-web` provider. It runs Codex tasks through a signed-in
Microsoft 365 Copilot Chat browser session at <https://copilot.cloud.microsoft/chat>. The original
`chatgpt-web` provider is unchanged.

The provider is intentionally separate: it has its own config, model catalog, local Responses
endpoint, browser profile, and text tool-call protocol. It does not replace or reconfigure the
ChatGPT Web route.

## What works

- Codex `POST /v1/responses` turns (streaming and non-streaming).
- Codex history, system/developer/user/assistant/tool-result messages, and declared tools.
- A text tool-call protocol that relays Codex tools through Copilot and back to the local Codex
  runtime.
- The dedicated Codex compaction endpoint (`POST /v1/responses/compact`).
- A static model catalog for `copilot-web/auto`, `copilot-web/quick`,
  `copilot-web/think-deeper`, `copilot-web/gpt`, `copilot-web/gpt-quick`, and
  `copilot-web/gpt-think-deeper`.
- A local health endpoint, optional bearer control token, and rejection of browser-originated
  POSTs.

## Requirements

- Bun 1.4+ and the repository dependencies (`bun install`).
- Google Chrome installed at the configured path.
- A Microsoft 365 account with Copilot Chat access. Some tenants expose only a subset of the model
  picker; `copilot-web/auto` is the safest choice.
- Interactive sign-in. Microsoft Entra credentials and MFA cannot be automated.

## Setup

```bash
bun install
bun run copilot:init
bun run copilot:login
bun run copilot:doctor
```

`copilot:login` opens a dedicated Chrome profile and waits for you to finish the Microsoft sign-in.
The browser closes when Copilot is ready. The profile is stored under
`~/.codex-copilot-web/chrome-profile` by default.

Then start the local Responses server:

```bash
bun run copilot:serve
```

It listens on `http://127.0.0.1:17842/v1` by default. The Copilot browser opens lazily on the first
turn.

## Use the macOS launcher

The launcher exposes Copilot as a separate **Copilot** item in its sidebar. It drives the same
commands without touching your ChatGPT setup or your default `config.toml`:

1. Open **Copilot** and choose **Initialize**. This creates
   `~/.codex-copilot-web/config.json`; nothing under `~/.codex` is changed yet.
2. Choose **Sign in** and complete the Microsoft sign-in in the Chrome window that opens. The
   launcher only marks the session as verified after `copilot login` exits successfully.
3. Choose **Start bridge**. The local Responses server starts on the configured endpoint, and the
   status row polls `/healthz`. Stop it from the same row when you are done.
4. Choose **Install profile**. This writes a separate `$CODEX_HOME/copilot.config.toml` (by default
   `~/.codex/copilot.config.toml`) and generates the model catalog next to the Copilot config.
   Start Codex with `codex --profile copilot`.

The managed profile omits `env_key` and sets `requires_openai_auth = false`, because the local
bridge does not need an API key. It also disables the `apps` and `plugins` feature flags: their
tool schemas are large enough to push a fresh Codex session past Copilot's ~128k-character composer
limit. The core Codex tool surface (shell, patch, plan, MCP resources, and your configured MCP
servers) remains available. Your default model, provider, and ChatGPT integration remain
unchanged. Use **Remove profile** to delete only the launcher-managed file; a
`copilot.config.toml` that lacks the launcher marker is never overwritten or removed.

Sign-in and sign-in checks are disabled while the bridge is running, because both use the same
dedicated Chrome profile. If the bridge was started outside the launcher, the panel marks it as
external and will not stop it.

## Connect Codex

Generate a catalog and a config snippet:

```bash
bun run copilot:config
```

Merge the printed values into `~/.codex/config.toml`:

```toml
model = "copilot-web/auto"
model_provider = "copilot-web"
model_catalog_json = "/Users/you/.codex-copilot-web/models.json"

[model_providers.copilot-web]
name = "Microsoft 365 Copilot Web"
base_url = "http://127.0.0.1:17842/v1"
env_key = "COPILOT_WEB_API_KEY"
wire_api = "responses"
supports_websockets = false
```

Set any non-empty key because Codex requires one for a custom provider:

```bash
export COPILOT_WEB_API_KEY=local
```

The local server ignores the key unless `controlToken` is set in the Copilot config.

Current Codex releases enable app and plugin tool catalogs that can add hundreds of thousands of
characters to the prompt before the first turn. The launcher-managed profile disables those
features with `apps = false` and `plugins = false` under `[features]`. If you connect manually and
see the prompt-size error, add the same settings to the profile you use for Copilot.

## Models

| Codex model | Copilot picker label | Notes |
| --- | --- | --- |
| `copilot-web/auto` | Auto | Let Copilot choose model and effort. Recommended default. |
| `copilot-web/quick` | Quick response | Lower effort for small edits. |
| `copilot-web/think-deeper` | Think deeper | Extended reasoning for difficult tasks. |
| `copilot-web/gpt` | GPT | Opens Copilot's GPT (OpenAI) submenu and picks its first model. The concrete names are tenant-specific (for example, `GPT-5.6 Sol Quick response`). |
| `copilot-web/gpt-quick` | GPT → `GPT-5.6 Sol Quick response` | A specific GPT submenu choice for fast answers. Edit `submenuLabel` when the tenant uses a different name. |
| `copilot-web/gpt-think-deeper` | GPT → `GPT-5.6 Sol Think deeper` | A specific GPT submenu choice with extended reasoning. Edit `submenuLabel` when the tenant uses a different name. |

The picker labels are configurable in `~/.codex-copilot-web/config.json`. A model can set
`menuLabel` for the top-level picker entry and `submenuLabel` for the concrete entry inside that
submenu. For example, to track a renamed GPT model:

```json
{
  "id": "copilot-web/gpt-quick",
  "menuLabel": "GPT",
  "submenuLabel": "GPT-6 Sol Quick response",
  "selectionLabel": "GPT-6 Sol Quick"
}
```

Copilot truncates long submenu names on the picker button (`GPT-5.6 Sol Quick response` becomes
`GPT-5.6 Sol Quick`). Set `selectionLabel` to the truncated text Copilot shows after selection;
when omitted, the bridge expects the button to show `submenuLabel` or `menuLabel` unchanged.

`copilot:doctor` prints the currently selected label, and `copilot:probe` records the visible menu
and DOM if a label does not match. When a model has no `submenuLabel`, the bridge picks the first
concrete model in the submenu. Add `submenuLabel` when you want a specific entry.

## How the tool protocol works

M365 Copilot has no Developer Mode, local MCP connector, or Secure MCP Tunnel equivalent. The
bridge therefore cannot expose Codex's local tools to Copilot as native functions. Instead, each
turn is compiled into a self-contained prompt containing:

- the Codex task context (system, developer, user, assistant, agent, and tool-result messages);
- the exact tool catalog with names, descriptions, and JSON schemas;
- instructions for emitting tool calls in this form, wrapped in a Markdown fenced code block so the
  chat renderer does not consume backticks, asterisks, or angle brackets:

````text
```json
<codex_tool_call>{"name":"shell","arguments":{"command":["pwd"]}}</codex_tool_call>
```
````

The adapter parses those blocks and emits ordinary Responses `function_call` items. Codex executes
the tool locally and sends the result back in the next turn, exactly as it would for any other
provider. Freeform tools such as `apply_patch` use `{"input":"..."}`. Namespaced MCP tools use the
`namespace__name` wire form.

A malformed block, an unknown tool name, or an unterminated block is a hard turn error. This is
deliberate: silently treating a failed tool call as prose would lose an action.

## Limitations

- **Text only.** Images in the Codex context are not attached to Copilot. The prompt tells Copilot
  not to claim it has seen them. Use a tool to inspect images, or add attachment support later.
- **Browser automation.** The adapter depends on Copilot's DOM. Microsoft can change the composer,
  model picker, send button, or response layout. Use `bun run copilot:probe` to capture diagnostics.
- **Serialized turns.** Turns share one Copilot browser page and run one at a time. Parallel Codex
  subagents will queue.
- **Context size.** The compiled prompt must fit Copilot's composer and the configured
  `maxPromptChars` (126,000 by default, just under Copilot's ~128,000-character ceiling). The bridge
  fails loudly instead of truncating history, and Codex is configured to compact before the cap.
- **No native Copilot tools as Codex tools.** Copilot may use its own web search or grounding, but
  those results are returned as text, not as structured Codex tool results.
- **Tenant policy.** Prompts, code, and tool results are sent to Microsoft 365 Copilot and are
  subject to the tenant's retention, DLP, audit, and acceptable-use policies. Use a tenant and
  account appropriate for the code you are working on.
- **Unofficial integration.** This is browser automation of a product without a public local API.
  It can break without notice.

## Commands

```bash
bun run copilot:init       # write the default config
bun run copilot:login      # sign in and persist the Chrome profile
bun run copilot:serve      # start the local Responses endpoint
bun run copilot:doctor     # check config, sign-in, and selector matches
bun run copilot:probe      # send a probe prompt and save DOM/transcript diagnostics
bun run copilot:config     # write models.json and print a Codex config snippet
bun run copilot:models     # print the model catalog
```

When using the packaged macOS app, the same commands are available through its bundled runtime:

```bash
"/Applications/Codex Web GPT.app/Contents/Resources/runtime/bin/codex-chatgpt-web" copilot serve
```

Options:

- `--port <n>` for `serve`, `doctor`, `probe`, `config`, and `models`.
- `--headless` / `--headed` for `serve`, `doctor`, `probe`, and `login`.
- `--cdp <url>` to attach to an existing Chrome started with `--remote-debugging-port` instead of
  launching the dedicated profile.
- `--no-send` for `probe` to inspect the page without submitting a prompt.
- `--prompt <text>` for `probe` or `doctor` to use a custom probe prompt.

## Configuration

Default path: `~/.codex-copilot-web/config.json`. Override the home with
`CODEX_COPILOT_WEB_HOME`.

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 17842,
  "copilotUrl": "https://copilot.cloud.microsoft/chat",
  "browser": {
    "mode": "persistent",
    "chromeExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "userDataDir": "/Users/you/.codex-copilot-web/chrome-profile",
    "headed": true
  },
  "models": [
    {
      "id": "copilot-web/auto",
      "displayName": "Copilot Auto",
      "menuLabel": "Auto",
      "description": "Microsoft 365 Copilot chooses the model and effort for the turn.",
      "contextWindow": 32000,
      "autoCompactTokenLimit": 24000,
      "defaultReasoningLevel": "medium",
      "supportedReasoningLevels": [{ "effort": "medium", "description": "Automatic" }]
    }
  ],
  "turnTimeoutMs": 900000,
  "loginTimeoutMs": 600000,
  "sendTimeoutMs": 30000,
  "responseStableMs": 3000,
  "maxPromptChars": 126000,
  "newChatPerTurn": true,
  "toolProtocol": true
}
```

`controlToken` is optional. When set, `/v1/*` requires `Authorization: Bearer <token>`.

Copilot accepts messages up to roughly 128,000 characters. The default `maxPromptChars` is 126,000,
and the model rows advertise a 32k-token context with compaction at 24k tokens so Codex compacts
before the compiled prompt reaches that character cap. Raising these values lets Codex send larger
turns, but Copilot can silently return an empty answer once the message is too long.

## Troubleshooting

### `Microsoft 365 Copilot is not signed in`

Run `bun run copilot:login` again and finish the Microsoft sign-in in the opened Chrome window.
The profile persists between runs. If another Chrome instance is using the same profile, close it
first.

### `Copilot model selector was not found`

The tenant may not expose the model picker. Try `copilot-web/auto`, or set `browser.mode` to `cdp`
and attach to a Chrome window where Copilot is already open. Run `bun run copilot:probe --no-send`
and inspect the saved JSON.

### `Copilot did not produce a readable answer`

Run:

```bash
bun run copilot:probe
```

The probe sends `Reply with exactly: COPILOT_PROBE_OK`, saves the transcript and candidate message
elements, and prints the extracted response. Update the selectors in `src/copilot/browser.ts` if the
DOM changed, then rerun the probe.

### The send button or Enter did not submit

The adapter first presses Enter, then falls back to an enabled Send button. If neither works,
`copilot:probe` records the visible buttons. The send control may need a new selector.

### Tool calls are not executed

Check the server log for `unknown tool`, `invalid JSON`, or `unterminated` errors. The model must use
the exact wire name from the tool catalog. Bare names are accepted only when unambiguous and are
normalized back to the namespaced wire name.

### `Compiled Copilot prompt is ... above the configured limit`

Compact the Codex task or raise `maxPromptChars` in the Copilot config. The practical ceiling is
about 128,000 characters; above that Copilot may answer with an empty or invisible message instead
of reporting an error. Codex's `contextWindow` and `autoCompactTokenLimit` values are deliberately
lower than that so automatic compaction runs first.
