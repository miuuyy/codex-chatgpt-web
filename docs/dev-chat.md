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
- Run its browser smoke test and initialize the DEV profile. Complete MCP setup only when testing
  simulated tool rounds; browser, effort, context-limit, and compaction work in browser-only mode.
  The launcher stores any MCP credentials only in the DEV home and supervises only that isolated
  tunnel. Create the ChatGPT connector as `Codex Native2 DEV`; keep `Codex Native2` unchanged.

Nothing is copied from the normal launcher. The DEV command fails closed if its own launcher,
browser descriptor, credentials, or connector are not ready. It never falls back to the production
profile, another model, a fake browser, or a second connector.

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

Reusing the same name continues its canonical Responses history. Each model turn still opens a
fresh Temporary Chat, exactly like production; the complete named history is compiled into that
turn by the existing prompt owner. New chats use the cheapest account-supported browser mode:
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
Compaction always uses the three-message path, even when its resulting summary will fit into a later
single-message turn, so the complete expanded history remains available to the summarizer.

Any missing or malformed acknowledgement fails the whole transaction. No later part or final
commit is sent, and a retry starts again from part one in a fresh Temporary Chat. The model context
and auto-compaction ceilings are reported as 3× while the switch is active, but every individual
stage must still fit the selected ChatGPT mode's measured one-message boundary.

Small turns add no requests. Two-part turns add two staging requests and acknowledgements; three-part
turns and compaction add three. Large turns are therefore slower and may increase the probability of
rate limits or a temporary account cooldown. The experiment is intentionally unavailable for Luna:
Luna's later requests still include the accumulated transcript inside the same measured
28,000-token browser transport budget.

Browser-only chats do not advertise outer tools and never claim simulated effects. Full setup keeps
the launcher-owned DEV tunnel ready so ChatGPT can create and validate `Codex Native2 DEV` before a
CLI chat starts. Each named chat attaches its broker to that tunnel, while every dispatched action
still returns an explicit simulation receipt.

The default isolated home is:

```text
~/.codex-chatgpt-web-dev/
├── config.json
├── codex-home/
├── launcher/                 # Electron userData, cookies, login, logs, window state
├── chats/<name>.json
├── runtime/
└── tunnel/
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
- does not start `Bun.serve` or bind the configured Responses port;
- rejects any attempt to start the Responses server from a `dev-harness` config;
- does not edit the normal `~/.codex/config.toml` or integration journal;
- leases an isolated DEV-launcher browser tab and runs the working-tree browser helper;
- owns the private DEV broker socket only for the command's lifetime;
- reuses the isolated tunnel supervised by the DEV launcher and never starts a competing alias;
- can run beside the production launcher, Responses port, and tunnel because none of their homes,
  browser partitions, descriptors, broker sockets, profiles, or aliases are shared;
- refuses to run Full-mode tool rounds until the launcher-owned DEV tunnel is ready;
- exposes ordinary structural tools, then returns a universal receipt containing
  `simulated: true` and `side_effects_performed: false` for every dispatched action.

The simulator has no keyword-to-result table and never claims that a command, patch, image read,
user interaction, or external mutation actually happened.
