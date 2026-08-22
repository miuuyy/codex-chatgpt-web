# Contributing

Keep the project narrow: ChatGPT web-backed Codex models only. Generic providers and unrelated
product surfaces are out of scope.

Core invariants:

- Model selection is explicit; never silently fall back to another model or reasoning level.
- Full mode exposes local tools only through the active outer Codex registry and official MCP
  tunnel.
- Browser-only mode never creates a broker capability or attaches an MCP connector; Full mode gives
  every available ChatGPT Web effort, from Luna through Pro, the same turn-bound MCP capability.
  Never introduce an effort-specific MCP exclusion.
- Browser state, API keys, tunnel IDs, cookies, Codex history, and absolute user paths never enter
  the repository.

Before opening a pull request:

1. Run `bun install --frozen-lockfile`, `bun install --frozen-lockfile` in `launcher/`, and
   `bun run verify`.
2. Add a focused regression test for protocol, compaction, MCP, browser parsing, or installer changes.
3. Do not commit cookies, browser state, tunnel ids, API keys, local absolute paths, or generated logs.
4. Preserve fail-closed behavior. A UI selector failure must not pick another model or claim success.
5. Keep Terms/trademark claims factual and never market the project as quota or rate-limit bypass.

For live browser development, start `bun run dev:launcher`, sign in inside the window labelled
**DEV**, initialize its browser-only profile, and use `bun run dev:chat NAME`. Configure its own
optional Full harness when testing simulated MCP/tool rounds. The DEV profile has
separate Electron state, browser login, configuration, sandboxed `CODEX_HOME`, broker, and tunnel
identity. Its launcher supervises the tunnel without starting a Responses daemon; named chats own
only their turn broker. Use the separate `Codex Native2 DEV` connector and leave the configured
production connector unchanged. It can coexist with the normal launcher without replacing the
Codex route or binding its Responses port. Use `/fill TOKENS` and `/compact` to reproduce context-boundary work; see
[docs/dev-chat.md](docs/dev-chat.md).

Browser UI changes should include the exact observed DOM evidence and a reproducible test fixture.
Do not broaden selectors speculatively.

Launcher changes must preserve native packaging on macOS, Windows, and Linux. Each package embeds a
platform-matched Bun runtime, so build it on the matching OS rather than cross-packaging. CI runs
the full verification and native package job on all three operating systems. Before publishing a
release candidate, complete the account-bound [release validation](docs/release-validation.md);
package smoke is not evidence that sign-in, MCP, compaction, or a real Codex turn works.
