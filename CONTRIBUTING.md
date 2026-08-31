# Contributing

Codex Web GPT was created and is primarily developed and maintained by
[@miuuyy](https://github.com/miuuyy). Product direction, core architecture, and release decisions
remain with the creator. Other contributors listed by GitHub have provided focused external fixes
rather than shared product or architectural ownership.

External contributions are welcome, but this is an intentionally maintainer-led project. Pull
requests are expected to be small, focused, and easy to review and verify. Good contributions
include isolated bug fixes, regression tests, documentation corrections, and narrow
platform-specific fixes.

Before opening a bug report, work through [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and use the
structured issue form. Reproduce once on the latest release and attach the privacy-safe export from
**Activity → Export safe log**; never upload raw browser state, credentials, or unredacted logs.

Large feature branches, broad refactors, rewrites, new providers, and changes to core behavior or
architecture are generally not accepted. In rare cases they may be considered, but discuss the
proposal in an issue before implementation. Prior discussion does not guarantee acceptance, and a
large unsolicited pull request may be closed even when substantial work went into it.

## Scope and invariants

- Keep the project focused on ChatGPT web-backed Codex models. Generic providers and unrelated
  product surfaces are out of scope.
- Model selection is explicit. Never silently fall back to another model or reasoning level.
- Full mode exposes local tools only through the active outer Codex registry and official MCP
  tunnel. Browser-only mode must not create a broker capability or attach an MCP connector.
- Every available ChatGPT Web effort has the same turn-bound MCP capability in Full mode. Do not
  add effort-specific MCP exclusions.
- Preserve fail-closed behavior. A selector or protocol failure must return an explicit error, not
  pick another option or claim success.
- Never commit browser state, cookies, API keys, tunnel IDs, Codex history, generated logs, or
  absolute user paths.

## Before opening a pull request

1. Run `bun install --frozen-lockfile` in the repository root and in `launcher/`.
2. Run `bun run verify`.
3. Add a focused regression test for behavior changes.
4. For browser UI changes, include the observed DOM evidence and a reproducible fixture. Do not
   broaden selectors speculatively.
5. Keep Terms and trademark claims factual. Do not market the project as a quota or rate-limit
   bypass.
6. Manually test the affected behavior. DEV mode is sufficient only when the change does not affect
   local-tool execution, MCP execution, or the outer Codex agent loop. Execution changes require a
   real installed Codex integration; DEV simulation is not end-to-end acceptance evidence.

Launcher changes must preserve native packaging on macOS, Windows, and Linux. Platform packages
must be built on their matching operating system. See [DEV chat mode](docs/dev-chat.md) for isolated
browser and MCP development, and [release validation](docs/release-validation.md) for the required
account-bound release checks.
