# Troubleshooting

This guide covers the failures reported most often in GitHub issues. Start here before reinstalling,
editing Codex configuration, or opening a new issue.

## The first five minutes

1. Install the [latest release](https://github.com/miuuyy/codex-chatgpt-web/releases/latest). Quit
   **Codex Web GPT** before running the installer again; updating preserves its private ChatGPT
   profile and launcher configuration.
2. In **Setup**, confirm that ChatGPT sign-in, the browser smoke test, and **Install into Codex**
   are green. The installation button says **Install models**, or **Reinstall** after setup.
3. Fully quit Codex, including its background process, and reopen it. Signing out, closing only the
   window, or starting another task does not reload the model catalog. Keep the launcher open.
4. Select a model ending in **(Web)** from Codex's model picker.
5. Run **Settings → Run doctor**. If the problem remains, reproduce it once and immediately use
   **Activity → Export safe log**.

Do not repeatedly press setup actions after they report success. The exact error and a fresh safe
log are more useful than another reinstall.

### Browser diagnostic retention

Browser checkpoints are stored under `~/.codex-chatgpt-web/diagnostics/browser-turns/`.
Failed captures are retained for up to three days within a 100 MB budget for finished captures.
Newer failures take priority over older failures and the ten most recent successful captures.
Active captures are never removed by cleanup. A burst of failures can exhaust the disk budget,
so copy any specifically requested checkpoint files before continuing a long investigation.
The safe-log export is separate and does not include these browser checkpoint files.

### Browser progress appears as assistant reasoning

ChatGPT's busy indicator uses `role="status"` and `aria-busy="true"` with a localized
screen-reader announcement. The bridge classifies that indicator as UI control metadata,
not a model-authored reasoning summary. This prevents browser interface text from reaching
downstream reasoning consumers, including language-policy checkers. Genuine public reasoning
summaries, intermediate commentary, final answers, and generation tracking retain their channels.

Update the app or runtime and fully restart it to replace code already loaded by the bridge.

## Models do not appear, or setup remains on step 3

**Install models** updates the Codex route. Once installation finishes, step 3 is complete and you
can connect MCP. The launcher checks model loading separately; waiting for that check does not
prevent MCP setup.

A running Codex process can keep its old model catalog. If **(Web)** models are missing, fully quit
every Codex Desktop window and Codex CLI process, then reopen Codex while the launcher is still
running. If a **(Web)** model already answers successfully, you do not need to reinstall just because
the launcher has not observed a new model-list request.

If the models still do not appear:

- confirm that **Codex itself** uses ChatGPT sign-in; signing into the launcher's browser is separate.
  An API-key or signed-out Codex session can show only its built-in catalog without contacting the bridge;
- open **Setup → Install into Codex** and click **Reinstall** once;
- check **Settings → Run doctor**; a healthy local proxy does not mean the upstream model-list
  request succeeded. Doctor reports its latest result separately;
- make sure another Codex wrapper is not replacing the route; and
- export a safe log after the failed catalog check.

A green step 3 followed by a browser-turn error means installation succeeded. Repeating step 3 will
not repair an unrelated ChatGPT browser or model-turn failure.

If Codex offers **only Luna (Web)** while the launcher's ChatGPT browser shows a paid model picker,
the saved account capabilities may be wrong. The October 29 control change caused this in v6.1.15
(#924, #932), including the subsequent Think-button timeout. Once the picker fix is installed, use
**Setup → Install into Codex → Reinstall** to refresh those capabilities, then fully restart Codex.
The launcher now requires a recognized model picker or Luna/Think control before saving this
result. If neither is recognized, report the setup error with a safe log; do not force Luna to run
under a different selected model.

### Windows: Cannot bind the local port (EACCES)

`Cannot bind 127.0.0.1:17841: listen EACCES: permission denied` means Windows refused access to
the port. Possible causes include a reserved port range, another service holding the address
exclusively, or security software. The error alone does not identify the cause.

Check reserved ranges and listeners in PowerShell:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
Get-NetTCPConnection -LocalPort 17841 -ErrorAction SilentlyContinue | Select-Object LocalAddress, State, OwningProcess
```

If 17841 falls inside a listed range, include that range in your report. Hyper-V, WSL, Docker and
Windows Sandbox can manage such reservations. If a listener appears, its OwningProcess identifies
the process to investigate. If neither check explains it, include both outputs and an
**Activity → Export safe log**. Reinstalling the launcher does not resolve an operating-system
reservation or another service's exclusive binding. Do not stop networking services or change
port reservations based only on the EACCES message.

## `openai_base_url changed after setup` or a model is "not supported"

The launcher deliberately refuses to overwrite a route changed by another tool. Only one program
can own Codex's `openai_base_url` at a time. Wrappers and routers such as OpenCodex, Headroom,
OmniRoute, Codex++, CC Switch, or a manually configured provider may replace the Codex Web GPT route
for the whole installation or only for the process they launch.

Choose one route owner:

- To use Codex Web GPT, disable the other wrapper's provider/proxy mode, click
  **Setup → Install into Codex → Reinstall**, fully restart Codex, and start Codex directly rather
  than through the wrapper command.
- A tool may remain enabled only as an MCP integration if it does not replace `openai_base_url`.
- To switch away cleanly, use **Settings → Remove Codex integration** first. This restores the exact
  route that existed before Codex Web GPT was installed.

Do not hand-edit the launcher's route journal. It exists so setup and removal can fail closed instead
of silently destroying another provider's configuration. First-class external-router composition is
tracked in [#205](https://github.com/miuuyy/codex-chatgpt-web/issues/205), but is not supported today.

## `Codex interrupt lifecycle hook changed after setup`

The launcher found that its entries in Codex's `config.toml` are missing or different from those
installed during setup. This can happen when another tool edits the file. Setup stops to avoid
overwriting those changes. A TOML parsing error instead means the file cannot be read; an invalid
integration journal means the launcher's saved setup record needs investigation.

Close Codex and any tool editing its settings, then make a copy of `config.toml`. It is normally in
`~/.codex` (Windows: `%USERPROFILE%\.codex`), or the folder selected by `CODEX_HOME`.
Compare it with a known-good backup made **after successful launcher setup**. Restore only the
launcher's affected `hooks.Interrupt` and matching `hooks.state` entries, preserving their order and
all unrelated settings and hooks. For a syntax error, repair the TOML or restore a known-good file,
keeping a copy of the current version so newer settings are not lost.

Then run **Setup → Install into Codex → Reinstall**. Do not delete all hooks or edit the launcher's
integration journal to bypass the check. If you have no suitable backup, or the error mentions the
journal, use **Activity → Export safe log** and open an issue with the exact error. Do not upload your
whole config file; it may contain credentials.

## A second `CODEX_HOME` fails with `missing network access in trusted Codex environment context`

The bridge normally reads native task permissions from its own `CODEX_HOME`. A CLI using a
different home stores its task records elsewhere. Its filesystem-only environment message does
not provide enough information to recover network permissions.

To share one bridge across your local Codex homes, set `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES`
**in the environment that starts the bridge or launcher**. Its value is a JSON array of up to seven
additional absolute local directories. For example, in PowerShell:

```powershell
$env:CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = '["C:\\Codex\\second-home"]'
& "$env:LOCALAPPDATA\Programs\Codex Web GPT\Codex Web GPT.exe"
```

Finish active tasks and quit the existing launcher before starting it with the new environment.
Replace the example paths with your actual home and launcher locations. Each home still needs its
own Codex integration setup; this setting registers where the shared bridge may read native task
records. Directories must already exist and must not themselves be symbolic links. The bridge
canonicalizes directory aliases and rejects a thread found in more than one registered home.

Each turn must match its current native thread, permissions, and turn ID. Shared-home mode does not
reuse the single-home permission cache. A secondary home's custom SQLite location must be set in
that home's `config.toml` as `sqlite_home`; the bridge's `CODEX_SQLITE_HOME` applies only to its
primary home. DEV commands keep their isolated home and discard this production setting.

## Native models stop after closing the launcher

While the integration is installed, native Codex models also use the local bridge. Keep the launcher
running, or use **Settings → Remove Codex integration** before quitting it. Then fully quit Codex,
including background processes, and reopen it to load the restored route.

CLI users can temporarily restore the previous route with `codex-chatgpt-web route disconnect`.
Fully restart Codex after a route change. Starting the launcher reconnects an installed integration.

## Codex's usage-limit banner disables Send for Web models

If Codex shows **You're out of Codex and Work usage** and disables Send even with a Web model
selected, sign out of **Codex** and sign in with another account you own that can send messages.
A free account with Codex access and no blocking usage banner can be used.

Keep your intended ChatGPT account signed in inside **Codex Web GPT**; these are separate sessions.
Changing the Codex login does not reset or increase the launcher's ChatGPT Web account limits.

## Encrypted content cannot be verified after switching models

If switching from ChatGPT Web to a native Codex model fails with `Encrypted content could not be
decrypted or parsed`, check the route owner. The launcher's native route already converts Web
checkpoints into readable context and preserves native encrypted history. An external router that
sends native requests directly to OpenAI bypasses that conversion.

Use one route owner as described above. If the error persists through the launcher, export a safe log
and include both model names and whether compaction preceded the switch. Do not delete checkpoints
or strip encrypted history; this can lose task context. External-router composition remains unsupported.

## ChatGPT sign-in does not complete

The launcher must own the ChatGPT session used for model turns. Signing in to an unrelated browser
window does not automatically transfer that session.

- Complete ordinary sign-in inside the launcher-owned flow and wait until a new chat composer
  is visible.
- Do not navigate or close the launcher browser while authentication or session verification is
  running.
- If the account offers **Try another way**, an alternate authentication method can avoid a
  platform-passkey limitation.
- On macOS, choose **Use passkey** to open a separate Chrome window. Sign in to ChatGPT there
  using your passkey. Once ChatGPT opens, return to the launcher and choose **I’m signed in — continue**.
  Keep that Chrome window open until you continue; the launcher closes it and verifies the imported
  session. Your usual Chrome profile is not used. Google Chrome must be installed.

If an ordinary login still fails, export a safe log immediately after one attempt. Include the OS,
launcher version, account tier, sign-in provider, and whether the new chat composer ever
appeared. Never upload cookies, browser storage, authentication headers, or raw profile files.

## The browser smoke test fails

The smoke test and real turns use the same current ChatGPT controls. Errors mentioning the effort
control, composer, send button, new chat, or an operational viewport usually
mean that the ChatGPT UI did not expose a structure the bridge can safely prove.

1. Update to the latest release.
2. Confirm that a new chat in the selected mode can be opened in the launcher and that the account is not
   showing a login, onboarding, capacity, or rate-limit dialog.
3. Run the smoke test one more time with the launcher visible.
4. If the same structural error remains, do not keep retrying. Export a safe log and open a focused
   bug report; ChatGPT UI drift must be fixed against the observed DOM, not guessed around.

Free and Go accounts normally expose Luna and Think without the paid-account effort selector. A
missing paid selector on those accounts is not itself a sign-in failure.
Luna and Think use rolling summaries with **Settings → Bigger Context** off. Experimental Bigger
Context keeps the task conversation and sends large histories in parts. If earlier details
are lost in long Free-account chats, turn Bigger Context off and restart Codex.

## A single message is too large for Bigger Context

`No ChatGPT effort available to this account can carry a Bigger Context stage` is a local
preflight rejection, before that message is sent to ChatGPT. Bigger Context distributes complete
messages and tool results across stages; it does not split an individual message or JSON record.
Increasing the advertised context window or the compaction threshold does not enlarge a stage.

Keep the context limits supplied by the launcher. Split large inputs into smaller messages before
submission, or put source material in files and ask Codex to read the relevant sections. Keep
individual tool results bounded too. If an oversized record is already in the task history,
compact the task or start a fresh task with smaller inputs.

If this still fails on an unmodified release with the default limits, open a new issue with
**Activity → Export safe log**, the failure time, account tier, model and effort. Distinguish the
local preflight error from a message-size error shown by ChatGPT after submission.

## Personalization or connector controls are not found

**Settings → Temporary Chat** is on by default. If your connector is
missing there, finish active tasks, turn that setting off, and retry. Connector availability can
differ between accounts and chat modes. The launcher does not silently change modes. The retired
saved-chat setting does not override the current preference. ChatGPT memory and custom instructions may
apply in either mode.

In ChatGPT, open **Settings → General → Language** and choose **English** explicitly, then reload
ChatGPT inside the launcher and retry once. Some browser controls depend on English labels;
changing the launcher language does not change the ChatGPT website language.
The same step applies when a model "could not be selected and verified".

## Full harness or MCP verification fails

Video walkthroughs:

- [Create an OpenAI tunnel and API key](launcher/src/assets/mcp-create-tunnel.mp4)
- [Connect the local harness and attach the ChatGPT connector](launcher/src/assets/mcp-connect-connector.mp4)

Browser-only mode needs no connector. Full harness mode requires all of the following:

- a newly created connector with the exact name shown in the launcher (**Codex Native2** by default);
- **Developer Mode** enabled in ChatGPT;
- the exact Tunnel selected with **Authentication: None**;
- the connector and Tunnel on the same OpenAI account as the ChatGPT workspace;
- **Allow all actions** under the connector's permissions; and
- **Connect harness** completed before **Verify runtime**.

If a turn reports **ChatGPT is waiting for plugin permission**, open the plugin's settings
in ChatGPT and choose **Permissions → Allow all actions**, then retry the turn. A visible
**Allow ChatGPT to use …?** card means ChatGPT is waiting for a permission decision. If
all actions are already allowed, open the ChatGPT tab and check the request; saved chats
can still ask for one-time approval. Wait for the Stop button to disappear before approving.
The launcher leaves unanswered requests untouched when the turn stops.

If ChatGPT says **MCP endpoint not found**, keep the launcher running and complete
**Connect harness** before creating the plugin. Use the same Tunnel ID in both places and
copy the plugin name from the launcher's MCP page. Do not enter both mode names as one name.
If ChatGPT then reports a request limit, wait for its cooldown before retrying once. If the
launcher shows the harness connected but creation still fails, export a safe log and include
the exact error and time of the attempt.

Do not rename or refresh an old **Codex Native** connector. ChatGPT caches the public MCP contract by
connector identity, so create **Codex Native2** as a new connector.

After updating, if `codex_exec` still does not expose `sandbox_permissions`, `justification`, and
`prefix_rule`, recreate the current mode's connector so ChatGPT loads the updated tool schema.
These fields only forward a permission request to Codex; its sandbox and approval policy still
decide whether the command can run. Ordinary commands do not require these optional fields.

### ChatGPT refuses a tool call or context compaction

Share the exact failed tool result and an **Activity → Export safe log**. An assistant saying
"safety block" without a failed tool result does not establish the cause. **Allow all actions**
does not override ChatGPT's own safety checks.

After updating, refresh **Codex Native2** in ChatGPT's plugin settings to load its current tool
descriptions. This updates the compaction tool contract; it does not remove safety restrictions.
If compaction ends without a submitted summary, the launcher reports that failure and preserves
the existing task history.

### A tool reports an invalid or expired turn token

A turn token identifies one active Codex turn. If ChatGPT changes or omits a character when copying
it into a tool call, the call is rejected. Tokens from finished turns are also rejected.

After updating the launcher, refresh **Codex Native2** in ChatGPT's plugin settings so it loads the
current token format and copying instructions, then retry the task in Codex. If the error continues,
attach **Activity → Export safe log** and the failure time. Do not include the token itself.

### Tools disappear on follow-up messages

If local tools work on the first message but disappear on a follow-up, check the same ChatGPT tab
in **Launcher → Browser**. ChatGPT may not retain the connector for the next message in a reused
conversation. The model saying it has no tools alone does not establish this.

In 6.0, enable **Settings → New browser chat for each turn** in automatic browser mode for this
case: the same Codex task continues, but each turn attaches the connector in a
fresh ChatGPT conversation. It resends more context and can be slower. In stock v5.0.8, close the
task's **completed** browser tab before sending the next message; closing a running tab cancels it.

Also try recreating **Codex Native2** as a new connector with the same Tunnel and **Allow all
actions**, then run **Verify runtime**. If tools are already missing in a fresh chat, report that
separately with a safe log and the browser's actual connector/tool state.

### Windows: `unable to verify the first certificate` or `SELF_SIGNED_CERT_IN_CHAIN`

The Windows launcher and packaged CLI use Windows-trusted certificates by default, including
certificates installed by your company or antivirus. Explicit `NODE_USE_SYSTEM_CA` settings are
preserved. Certificate verification remains enabled.

If it still fails, check the affected host with Windows `curl.exe -Iv`
(for example, `curl.exe -Iv https://api.openai.com/`). If it uses Schannel and receives an HTTP
response, Windows trusts that connection. For an older launcher, fully quit it and start it from PowerShell:

```powershell
$env:NODE_USE_SYSTEM_CA = "1"
$install = (Get-ItemProperty "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02").InstallLocation
Start-Process (Join-Path $install "Codex Web GPT.exe")
```

For a portable copy, use its executable path instead. Retry **Connect harness** once. This enables
[Node's system CA support](https://nodejs.org/api/cli.html#node_use_system_ca1); certificate verification
stays enabled. If it still fails, export a safe log. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### ChatGPT will not reuse a deleted plugin's name

In the launcher, open **Settings → Plugin name**, change the part after **Codex**, and confirm.
For example, replace **Native2** with **Work** to get **Codex Work**. Create a new plugin using
the exact name shown in **MCP**, then verify it again. Only the current mode's name changes;
the tunnel credentials and ChatGPT login are kept. Do not rename the retired
**Codex Native** plugin to reuse its old schema.

### Zero Risk: the prompt was not sent

Confirm **Sent** only after ChatGPT accepts the prompt. If sending is blocked, choose an available
model yourself. **Copy prompt** gives you a fresh handoff timer before Sent and remains available
after Sent until the plugin starts. Copying does not send another message or change the model.

### ChatGPT shows `Error creating connector`

1. Confirm that the Tunnel ID and the regular API key used by the launcher were created under the
   same OpenAI account.
2. Confirm that the launcher has connected the local harness and the Tunnel is running before you
   create the connector in ChatGPT.
3. ChatGPT can reject the first **Create** attempt once even when the Tunnel is healthy, usually
   after 5–10 seconds. Press **Create** one more time. If the second attempt also fails, stop
   retrying and recheck the account, Tunnel ID, and running Tunnel first.

If tool calls work until native Codex quota is exhausted and then edits are denied by **Automatic
approval review**, disable that optional Codex review setting and restart Codex. The outer Codex
sandbox and explicit approvals still apply; this only prevents an unavailable native model from
being inserted as an extra reviewer after the Web tool call already completed.

## Long-running commands and MCP deadlines

Each MCP invocation has a 90-second deadline. Command polling through `codex_write_stdin`,
`codex_tool_call`, or the native `exec` gateway accepts `yield_time_ms` up to 60,000 ms.
Longer waits are rejected before dispatch without retiring the task. Return after each poll;
if the result still has a `session_id`, use a separate call to collect more output.
The command continues running between polls. Changing `stallTimeoutSec` does not change the
MCP invocation deadline.

After updating, if ChatGPT still advertises a five-minute maximum for `codex_write_stdin`,
recreate the current mode's connector with the same Tunnel and permissions to load its updated
tool schema. Existing connectors receive an explicit validation error for an excessive wait;
the bridge does not silently shorten the requested duration.

## `Reconnecting`, `stream disconnected`, or `ChatGPT failed`

These are result boundaries, not one diagnosis. The bridge uses them when it cannot prove a complete
ChatGPT turn. Common causes include an account-side rate limit, ChatGPT's own "Something went wrong"
state, a changed UI control, a closed browser surface, a conflicting route, or a tool that exceeded
its bounded MCP deadline.

- Read the final detailed error after the reconnect attempts; do not report only the word
  `Reconnecting`.
- Retry once in a fresh Codex task. State whether the fresh task works and whether the failure is
  consistent.
- Run **Settings → Run doctor** and export a safe log immediately after the failure.
- Include the exact model, Browser-only or Full harness mode, whether tools ran, and whether the
  ChatGPT page showed a final answer.

Do not assume that a generic 502 means the Tunnel is broken. Since v4.0.7, a native tool that
outlives its turn binding is reported explicitly as `codex_tool_timeout` and retired rather than
being presented as an ambiguous proxy success.

If Stop disappears before the final answer, the bridge allows up to ten minutes without new
observable response activity. A visible error or a completed empty answer has its own check.
An idle timeout does not establish why ChatGPT stopped responding. Keep the original ChatGPT tab
when reporting this case, and mention whether its final answer appeared after the error.

For repeated compaction, the safe log includes `context_token_breakdown`: character and token
counts grouped by instruction/message role, without their contents. These counts distinguish a
large fixed instruction load from growing conversation history. They cover individual submitted
records; the full input estimate also includes transport framing, attachments and platform reserve.

## Saved task environment cannot be read

If an interrupted shutdown damages `runtime/thread-environments.json`, start a fresh Codex task.
When Codex supplies a verified workspace and permissions, the launcher preserves the damaged JSON
beside the original as `thread-environments.json.corrupt-…` and rebuilds the file from that current
task. It does not recover permissions from damaged data. Existing tasks without a current verified
environment may still need to be restarted.

If the error remains or reports invalid workspace/permission records, export **Activity → Export
safe log** and include the exact error. Keep the preserved file private; do not delete your launcher
settings or upload the saved task environments.

## A custom compaction limit causes `context_window_exceeded`

Run **Settings → Run doctor**. A global or default-profile `model_auto_compact_token_limit` overrides
the model's advertised threshold. A value chosen for a native model may exceed a Web model's
limit. Remove that override to use per-model defaults, then restart Codex. Also check any
`model_context_window` override; a context window smaller than the compaction threshold can fail
before compaction starts. Doctor reports conflicting saved settings without editing them.

Doctor cannot inspect command-line or project-specific overrides. If the error remains, include
the selected model, launcher/Codex versions, these two settings and the failure time with your safe
log. Do not post your entire configuration or credentials. An error message alone does not prove
that these settings caused the failure.

## Native compaction returns `404 Not Found`

For an ordinary Codex model, `/v1/responses/compact` forwards to the native legacy compact
endpoint. That endpoint can return an upstream 404 even when the model and authorization work.
Check whether a config layer sets `[features].remote_compaction_v2 = false`. Current Codex enables
V2 by default; remove that override or set the existing key to `true`, then restart Codex and retry
compaction on the same native model. V2 uses `/responses` with a compaction trigger.

If it still fails, include the effective feature setting, selected model, exact failure time and
safe log. `native_compaction_upstream_failed` records the route, model, HTTP status and available
request identifiers without prompt contents or credentials. A separate Web context-length error
still requires its own diagnosis; changing the native protocol does not increase Web input limits.

## ChatGPT says the account is temporarily limited

The bridge permits at most five simultaneous browser tabs as an account-safety ceiling. Five is not
a recommended concurrency setting, and ChatGPT does not expose a stable numeric quota or cooldown.
Some accounts have reached a limit with only two turns started close together.

After the first account-side limit response, stop retrying and let the cooldown clear. For a
conservative starting point, set one spawned agent thread at a time in the existing `[agents]`
section of `~/.codex/config.toml`:

```toml
[agents]
max_concurrent_threads_per_session = 1
```

If the table already exists, add or change only the key; do not create a second `[agents]` table.
If it contains `max_threads`, replace that old name with `max_concurrent_threads_per_session`;
do not keep both. Codex treats them as aliases and may reject the configuration as a duplicate field.
Bigger Context can make one turn larger and longer, but does not increase safe account concurrency.

## Images from earlier turns are attached again

Codex includes prior task images in the canonical conversation context. The bridge follows that
context and keeps only the newest ten complete images, so seeing an earlier image again in the same
task is expected. Start a new Codex task when the new request must not carry earlier image context.

Open an issue if the launcher reports that ChatGPT did not accept all attachments, or if images from
a different Codex task appear. Include a fresh safe log with the failing trace and attachment stage.
Do not replace inline images with arbitrary local paths: browser-only and compaction turns
intentionally do not receive unrestricted filesystem access.

## Image generation stops before an image appears

Image generation inside the ChatGPT browser conversation is not currently a supported turn type.
ChatGPT uses a separate generation lifecycle that the text-response bridge cannot reliably prove
complete or retrieve through its current contract.

Codex's native Image Gen tool uses a different path: it sends `/v1/images/generations` or
`/v1/images/edits` through the configured Codex base URL. The bridge forwards those requests to the
native Codex backend using the incoming Codex authorization. A local `404 Not found` on these paths
in 5.0.4 or earlier is a missing bridge route, not proof of an OpenAI plugin or backend failure.
Upstream authentication and image-allowance errors remain unchanged; the ChatGPT browser connector
does not provide credentials or additional allowance for native Image Gen.

## Update, repair, and remove

To update, quit **Codex Web GPT** and run the same installer command from the README. The installer
replaces the application and runtime while preserving the launcher configuration and private
ChatGPT profile.

On Linux, automatic updates require the installed launcher created by `install-launcher.sh`.
If Update reports that the stable wrapper is missing, quit the app, run the installer command
from the README, and reopen Codex Web GPT from the applications menu. This preserves settings and browser data.

To repair a valid integration, open **Setup → Install into Codex**, click **Reinstall** once,
and fully restart Codex. Avoid deleting configuration until **Run doctor** and a safe log identify
which layer failed.

To remove the integration safely:

1. Open **Settings → Remove Codex integration** and wait for it to restore the previous Codex route.
2. Fully restart Codex.
3. Quit the launcher and uninstall the application normally for the platform.
4. If Full harness was configured and is no longer wanted, separately delete **Codex Native2**, its
   Tunnel, and the API key created for that Tunnel from the corresponding account settings.

Deleting the application before step 1 can leave Codex pointed at a local route that no longer
exists.

## Open a useful bug report

Use the repository's bug-report form and attach the privacy-safe export from **Activity → Export
safe log**. A useful report contains:

- launcher version and installation method;
- Codex Desktop and/or CLI version;
- OS and architecture;
- ChatGPT account tier;
- Browser-only, Full harness (automatic), or Zero Risk mode and the exact selected model;
- For Zero Risk, the ChatGPT model/effort and the last completed step: copying, pasting, sending in ChatGPT, confirming Sent, or the first MCP call;
- exact reproduction steps and complete final error;
- whether it reproduces in a fresh Codex task; and
- a safe log captured immediately after that reproduction.

Screenshots are welcome, but a screenshot without the exact error and fresh log is usually not
enough to distinguish setup, routing, browser DOM, account, and MCP failures.

Before uploading anything, read [SECURITY.md](SECURITY.md). Never publish raw launcher logs, cookies,
browser storage, API keys, Tunnel IDs, full Codex prompts, tool output containing private data, or
absolute private paths.
