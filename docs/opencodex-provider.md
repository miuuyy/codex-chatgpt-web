# OpenCodex provider

This project can run as an independent Responses provider behind OpenCodex. Codex keeps talking
to OpenCodex. OpenCodex routes only the selected ChatGPT Web models to this loopback server.

Use `--integration-mode external-provider` explicitly. The default remains `direct`, which still
owns Codex `openai_base_url`.

## What this process owns

- Loopback Responses listener on `127.0.0.1`
- ChatGPT browser login and account capability detection
- Optional Full-mode broker, MCP tunnel, and tool approvals

It does **not** create, modify, delete, or restore Codex `openai_base_url`, `model_provider`,
OpenCodex config, or model catalogs. Start, restart, Repair, Doctor, update, and uninstall keep
that rule.

## Source setup

Use isolated homes so the live user profile is never rewritten:

```bash
export CODEX_CHATGPT_WEB_HOME="$PWD/.tmp-chatgpt-web"
export CODEX_HOME="$PWD/.tmp-codex-unused"
bun run src/cli.ts setup --browser-only --integration-mode external-provider --acknowledge-unofficial
bun run src/cli.ts serve
```

Sign in through the configured browser host, then confirm:

```bash
curl -sS http://127.0.0.1:17841/healthz
curl -sS http://127.0.0.1:17841/v1/models
```

`healthz` reports `integration_mode: "external-provider"` and a `provider_base_url`.
`/v1/models` lists only ChatGPT Web routes this account can use. It does not call official Codex
model discovery.

Full mode is independent of routing ownership:

```bash
bun run src/cli.ts setup --full --integration-mode external-provider --acknowledge-unofficial
```

That still requires the existing tunnel, connector, and tool-approval flow. It does not force
Browser-only, and it still must not rewrite Codex routing.

## OpenCodex registration

Verified against OpenCodex `main@2d4d7a22381a2e497c2442902104619e25f937c7`. The
`openai-responses` adapter posts to `{baseUrl}/v1/responses` unless `responsesPath` is set, so
`baseUrl` should include `/v1`. Compact for this provider is a routed summarizer turn into
`POST /v1/responses`, not OpenAI's native `/responses/compact` backend.

CLI shape that exists in that OpenCodex revision:

```bash
ocx provider add chatgpt-web \
  --adapter openai-responses \
  --base-url http://127.0.0.1:17841/v1 \
  --allow-private-network
```

Then, in OpenCodex config or the provider editor, set live model discovery on and leave the API
key blank if the UI allows a keyless local provider. If a placeholder key is required, it is only
a local token for OpenCodex; this server does not authenticate ChatGPT with that value.

Equivalent config fragment:

```toml
[providers.chatgpt-web]
adapter = "openai-responses"
baseUrl = "http://127.0.0.1:17841/v1"
allowPrivateNetwork = true
liveModels = true
keyOptional = true
```

Keep Codex pointed at OpenCodex. Do not point Codex `openai_base_url` at this bridge, and do not
point this bridge at OpenCodex. Unknown models return an explicit error instead of falling back to
official Codex or OpenCodex.

## Recovery

To return to Direct mode, rerun setup without `external-provider`:

```bash
codex-chatgpt-web setup --browser-only --integration-mode direct --acknowledge-unofficial --replace-codex-route
```

That is an explicit Direct takeover. It is not a silent fallback. Do not restore an old Codex
`config.toml` backup over a file OpenCodex currently owns.

To leave routing with OpenCodex and only stop this provider, uninstall with the isolated home or
use the launcher Remove action after selecting external-provider. Uninstall in that mode does not
rewrite Codex routing.
