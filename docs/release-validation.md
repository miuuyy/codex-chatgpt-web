# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account:

1. Install the packaged launcher on a clean profile and prove that the embedded Bun runtime starts.
2. Sign in inside the embedded browser and prove that Temporary Chat reaches a usable composer.
3. Install the Codex model route, restart Codex, and prove that every account-available ChatGPT Web
   effort appears exactly once without removing native models.
4. Complete one Browser-only turn and verify streamed commentary plus the final answer.
5. Configure the `Codex Native2` connector, run **Verify runtime**, and complete one Full-mode local
   tool turn. Repeat with Pro when the account exposes Pro.
6. Drive a chat past the compaction threshold and prove that it continues after compaction without
   a duplicate or orphaned browser turn.
7. Cancel a running turn by closing its launcher tab, then cancel another with the launcher action;
   prove that neither turn recreates a tab or keeps the runtime busy.
8. Quit the launcher during an active turn, confirm the explicit cancellation path, reopen it, and
   prove that the saved ChatGPT session and Codex route are still valid.
9. Disconnect the bridge and prove that the exact previous Codex route is restored. Reconnect it
   and prove that the existing private MCP credentials are reused rather than replaced.
10. Upgrade from the previous public release and prove that launcher state, browser state, Codex
    settings, and MCP configuration survive the updater transaction.

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

### v3.0.0 result

Maintainer validation passed on Windows 11 x64 on 2026-08-22 using the published v3.0.0-alpha
upgrade package and a real ChatGPT Pro account. The authenticated launcher, Codex model catalog,
Full-mode MCP tools, Pro turns, compaction, cancellation, session reuse, and preserved connector
configuration were exercised successfully. The direct installer completed successfully but gave no
clear completion action; v3.0.0 changes it to an assisted installer with a final launch option.

## macOS gate

Repeat items 2 through 10 on the oldest supported macOS version or the closest maintained machine.
Packaging smoke and code-signing verification remain separate gates; neither substitutes for the
interactive account flow.

## Linux gate

CI packaging smoke is required. Before claiming interactive Linux support for a release, repeat
items 2 through 7 under a supported desktop session and record the display server and packaging
format used.
