# DEV chat harness

The repository DEV chat exercises current source code without routing the native Codex app through
that working tree. It is intended for browser, MCP, tool-round, retry, and compaction development
while the normal launcher, its ChatGPT account, and the maintainer's active Codex session remain
usable.

## Prerequisites

- Use the repository-pinned Bun version.
- Install a launcher built from the same working tree.
- Start the isolated launcher with `bun run dev:launcher`.
- It skips the normal marketing onboarding and opens the setup surface directly. Sign in inside the
  window labelled **DEV**. This may be a different ChatGPT account.
- Run its browser smoke test and initialize the DEV profile. Complete Full setup only when testing
  simulated tool rounds; browser, effort, context-limit, and compaction work in browser-only mode.
  Full setup takes the display name of the existing ChatGPT-facing Routing_MCP connector so the
  browser can select it. That name is not the downstream Plugin identity. DEV setup does not create
  a DEV-specific Tunnel or connector.

Nothing is copied from the normal launcher. The DEV command fails closed if its own launcher,
browser descriptor, or configured Routing_MCP connector are not ready. It never falls back to the
production profile, another model, a fake browser, or a second connector.

When migrating an already verified automatic DEV profile from terminal-only managed Chrome to the
DEV launcher, `dev setup` may use `--reuse-stored-account-capabilities` to keep the explicitly
persisted `solAvailable` / `proAvailable` values while still validating the launcher-owned ChatGPT
session and Temporary Chat surface. The option is DEV-only, cannot be combined with
`--refresh-account-capabilities`, and is rejected for any other profile or interaction mode. Without
the flag, launcher setup keeps the normal capability-probe behavior.

## Run

One browser-only message:

```bash
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat smoke "Reply with exactly: DEV READY"
```

Persistent interactive chat:

```bash
bun run dev:chat compaction-lab
```

After optional Full/MCP setup, the same command also exposes simulated outer tools:

```bash
bun run dev:chat tool-lab "Use a command tool and explain the simulated receipt"
```

The direct DEV tool `mcp__dev_simulator__large_context_payload` accepts the explicit arguments
`segment` (1, 2, or 3) and `target_tokens` (1,000 to 95,000). It returns deterministic, coherent,
inert prose through the real simulated MCP-result path so a live named chat can exercise retention
and automatic compaction without embedding a giant fixture in the user prompt. It is advertised
directly rather than through deferred tool search so the test can prove the requested call happened.

Reusing the same name continues its canonical Responses history. Sequential native messages in the
same compaction epoch lease one Temporary Chat, exactly like production. Every message receives a
new turn-bound MCP token, and all MCP tool rounds for that message remain inside the same ChatGPT
response. On an exact native compaction request, the same Web agent submits the checkpoint through
a one-shot MCP control call in that chat; only then does the surface close and the next epoch open a
new Temporary Chat. The complete named history remains owned by the existing prompt compiler. New
chats use the cheapest account-supported browser mode:
Instant (`light`) when Sol is available, otherwise Luna. Override it with `--model` or `/model`.

Interactive commands:

```text
/status
/fill 30000
/send-fill 12000
/compact
/model high
/reset yes
/help
/exit
```

`/fill N` appends deterministic inert text measured by the production tokenizer. It does not open
ChatGPT. The next message checks the real model-specific auto-compaction threshold and calls the
same `compactRequest` handler when the threshold is crossed. `/compact` forces that handler
immediately. Luna keeps its production rolling-checkpoint contract and therefore rejects the
separate compact command.

`/send-fill N` sends deterministic inert text as the current message through the live browser. Use
it to exercise the one-message composer budget and multi-chunk prompt insertion independently of
history growth. The normal model-specific browser preflight still applies and fails closed above
the measured transport limit.

## Bigger Context experiment

Both launcher profiles expose **Bigger Context (experimental)** in Settings. It is disabled by
default. The switch updates the profile's canonical runtime configuration through the normal setup
transaction; it is not a launcher-only preference. Production setup also rewrites the managed
Codex model catalog with 3x context and auto-compaction thresholds and asks you to restart Codex.
The DEV CLI reads the same setting from its isolated runtime configuration on each command.

When enabled, a normal turn stays on the original single-message path while its estimated input
is below the selected mode's existing auto-compaction threshold. At the first threshold it uses two
messages; at twice that threshold it uses three messages. The final context part also commits the
transaction and starts the task, so there is no extra request. The existing DEV compaction threshold
remains three times the selected mode's base limit.

Each stage contains complete semantic records, never a raw JSON string cut in the middle. The model
must return an exact transaction-bound SHA-256 acknowledgement before the next part is sent.
Images, the MCP connector, and the private `turn_token` are attached only to the final part.
In Full/MCP mode, compaction does not replay the expanded history into an unrelated summarizer. If
the source Web response is still waiting on a tool boundary, its canonical tool results finish that
response first without a compaction suffix. If those results are enough for an ordinary final
answer, that committed answer remains owned by the logical Responses turn across the physical chat
retirement. If the Web model instead requests another tool, the broker blocks that new execution
and tells the response to stop; the compacted continuation then resumes the unfinished work. The
exact retained chat receives one strict checkpoint message with only the one-shot MCP control
capability and no ordinary work capability. The checkpoint never rides in the tail of a potentially
huge tool result, and its wait is capped at five minutes independently of the normal turn timeout.
After the structured handoff is accepted, the bridge explicitly ends that one-purpose browser turn
and waits for its physical launcher settlement before closing the old surface; the next epoch then
starts a fresh Temporary Chat. This does not depend on ChatGPT rendering assistant text or a Copy
action after the control-only response. If the retained private chat was already closed, the bridge
starts one read-only fallback chat from the canonical Codex history instead. Browser-only mode
has no retained MCP boundary and keeps the three-message compaction path so its summarizer receives
the complete expanded history.

Any missing or malformed acknowledgement fails the whole transaction. No later part or final
commit is sent, and a retry starts again from part one in a fresh Temporary Chat. The model context
and auto-compaction ceilings are reported as 3× while the switch is active, but every individual
stage must still fit the selected ChatGPT mode's measured one-message boundary.

Small turns add no requests. Two-part turns add two staging requests and acknowledgements; three-part
turns add three. Browser-only compaction also uses three stages. Large turns are therefore slower and may increase the probability of
rate limits or a temporary account cooldown. The experiment is intentionally unavailable for Luna:
Luna's later requests still include the accumulated transcript inside the same measured
28,000-token browser transport budget.

Browser-only chats do not advertise outer tools and never claim simulated effects. Full setup
selects the existing ChatGPT-facing Routing_MCP connector. The DEV launcher owns one stable
loopback daemon, broker, and Streamable HTTP `/mcp` endpoint; each named chat attaches remotely to
that broker. The downstream `codex-chatgpt-web` Plugin is registered separately in Routing_MCP;
every dispatched DEV action still returns an explicit simulation receipt.

The default isolated home is:

```text
~/.codex-chatgpt-web-dev/
├── config.json
├── codex-home/
├── launcher/                 # Electron userData, cookies, login, logs, window state
├── chats/<name>.json
└── runtime/
```

Set `CODEX_WEB_GPT_DEV_HOME` to choose another absolute DEV home. Generic `--home`,
`CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, and `CODEX_WEB_GPT_LAUNCHER_DATA_DIR` never collapse the DEV
launcher into production storage.

## Isolation contract

The DEV driver:

- requires a descriptor explicitly marked `development` and a config explicitly marked
  `dev-harness`;
- uses a separate Electron `userData` directory and a separate persistent browser partition, so
  cookies, OAuth state, local storage, account selection, and launcher state cannot cross profiles;
- uses an isolated sandbox `CODEX_HOME` but never writes a Codex route into it;
- does not call setup, route connect/disconnect, service start/stop, or uninstall;
- never starts a Responses daemon from the named-chat CLI; in Full Routing mode the DEV launcher
  owns the configured loopback daemon and Plugin `/mcp` endpoint;
- rejects any attempt to start the Responses server from a `dev-harness` config;
- does not edit the normal `~/.codex/config.toml` or integration journal;
- leases an isolated DEV-launcher browser tab and runs the working-tree browser helper;
- owns the private DEV broker socket only for the command's lifetime;
- uses the existing ChatGPT-facing Routing_MCP connector and creates no DEV-specific Tunnel or alias;
- keeps the downstream Routing Plugin identity separate from that connector display name;
- can run beside the production launcher because its home, browser partition, descriptor, broker
  socket, and loopback MCP endpoint are isolated;
- refuses to run Full-mode tool rounds until the launcher-owned broker is ready and a non-Standalone
  Routing connector name is configured;
- exposes ordinary structural tools, then returns a universal receipt containing
  `simulated: true` and `side_effects_performed: false` for every dispatched action.

The simulator has no keyword-to-result table and never claims that a command, patch, image read,
user interaction, or external mutation actually happened.
