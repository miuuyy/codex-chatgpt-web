# ChatGPT Project routing patch: build, update and rollback (Windows)

Optional feature, off by default. Base: official `v6.2.0`. Patch is one commit on branch `project-routing`
(`git format-patch -1 project-routing`), kept separate from the official install and from user data
(`config.json`, auth, browser profiles are never touched by building).

## Behaviour
- `setup --project-url https://chatgpt.com/g/g-p-<id>/project` (or Settings → ChatGPT Project) stores `chatgptProjectUrl`.
- New saved chats start on the project page. Requires ordinary chats (`--ordinary-chats`).
- Invalid URL, or a project together with Temporary Chat, is rejected by setup, config load and the launcher; nothing is written.
- `--clear-project-url` restores default behaviour. Sign-in/account probes keep using the ChatGPT root.

## Build (separate checkout; official install untouched)
```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && cd codex-chatgpt-web
git checkout v6.2.0 && git switch -c project-routing
git am path/to/project-routing.patch        # or: git cherry-pick <commit>
bun install && bun --cwd launcher install
bun run typecheck && bun run launcher:typecheck
bun test ./tests && bun run launcher:test
bun run build && bun run app:package         # installer: launcher/artifacts/codex-web-gpt-<ver>-win-x64.exe
```
Do not run `bun run app:smoke` casually: it silently installs the package for the current user.
Known baseline failures on Windows (not caused by the patch): 2 symlink EPERM tests, plus occasionally
timing-sensitive compaction "send" stage tests.

## Update to a new official release
1. `git fetch --tags && git switch -c project-routing-<new> <new-tag> && git cherry-pick project-routing`.
2. Resolve conflicts, expecting these touch points: `src/chatgpt-session.ts` (`chatGptNewChatUrl`, `assertNewChatPage`),
   `src/config.ts`, `src/setup.ts`, `src/cli.ts`, `src/dev-chat/cli.ts`, `src/adapters/chatgpt-web/browser-worker.ts`,
   `launcher/electron/{runtime,main,state,preload,browser-host}.cjs`, `launcher/src/{App.tsx,types.ts,i18n.ts}`.
3. Re-run the validation commands above; `tests/chatgpt-project-routing.test.ts` is the regression guard.
4. Official update notifications are unchanged; install the official release again to drop the patch.

## Rollback
- Feature off: Settings → clear the project, or `setup --clear-project-url`. Behaviour reverts immediately.
- Full removal: reinstall the official `v6.2.0` installer over the patched one; `config.json` keeps a harmless
  `chatgptProjectUrl` key only if it was set (clear it first, since an older build ignores unknown keys but a project plus
  Temporary Chat would be a conflict in this build).
- Source: `git switch main` / drop the `project-routing` branch.

## Live validation (needs a signed-in browser; not run by the build)
In a throwaway ChatGPT Project: new conversation lands in the project; retained second turn reuses it; an MCP tool call
completes; forced compaction opens a fresh chat inside the project and continues; clearing the URL returns to root chats.

### Recorded live run (Windows, v6.2.0 + patch, 2026-11-24)
Drive turns with a routed model slug, e.g. `codex exec -m chatgpt-web/gpt-6.2-sol ...`. The plain `gpt-6.2-sol` slug is
native Codex and is passed through, so it never touches the browser and proves nothing. Evidence is the redacted
`diagnostics/browser-turns/*/` traces (`location.pathSegments`: 3 = project page, 4 = project conversation).
- New chat: project page (3) -> conversation (4). Temporary Chat off.
- Retained turn: no navigation, stays at 4, recalled earlier content.
- MCP tool call (`n8n-native/search_workflows`): started and completed.
- Compaction (`-c model_auto_compact_token_limit=20000`): handoff accepted in the old chat, continuation opened a fresh
  chat from the project page (3 -> 4) and the following turn retained context in it.
- Clearing the URL and entering an invalid URL in the launcher UI were tested live by the owner and behaved as expected (also covered by offline tests).
