# Project continuity

This project bridges Codex requests through an authenticated ChatGPT browser session and ships an Electron launcher. Use the exact Bun version in package.json.

## Experimental context transport

- Bigger Context uses complete v3 JSON in a TXT attachment for large automatic Instant, Medium, High, Extra High and Pro requests. Small requests remain inline; manual Zero Risk and legacy Luna behavior is unchanged.
- Preserve the selected mode. Do not add native inference or paid API fallbacks. File-assisted task success is not proof of a larger internal model context window.
- Count the file, instructions, images and platform reserve. Fail explicitly on excess size; never trim a context file silently. A TXT attachment leaves nine image slots.
- File-based native turns start fresh web conversations with complete history. Same-turn tool results share the active broker/runtime. Preserve trusted native environment and compaction authority.
- The launcher and CLI expose Plus/Pro budget selection. Plus budgets remain conservative even when the account exposes Pro modes; selecting a budget does not unlock unavailable models. Configured ceilings are not guarantees of full recall, and actual Plus-account file behavior still needs live verification.
- Keep account sessions, credentials, local runtime evidence and personal routing integrations out of commits.

## Verification

- Run `bun run verify` for audits, types, tests, renderer/runtime builds and relocatable startup.
- Run `bun run app:package` and `bun run app:smoke` on the matching OS. Validate actual PR CI on macOS, Windows and Linux; local success does not establish other platforms.
- `scripts/smoke-installed-context-file.ts [chatgpt-web/model]` is an opt-in live test against an already running installation. It sends synthetic data, executes harmless local commands and tests a second native turn. Its guard locks all requests to the selected Web route. It consumes ChatGPT web usage; never run it as ordinary CI.
- Source changes do not update an installed application. Do not restart or replace a user's app merely to edit a PR.
