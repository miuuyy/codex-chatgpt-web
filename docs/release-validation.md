# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

## Passkey account gate

This is an additional account-bound gate, not a replacement for embedded sign-in. Run it on every
desktop platform for which the release claims passkey fallback support, using a real account or
workspace policy that requires passkey or advanced browser authentication that the embedded
Electron flow cannot complete. Record the redacted browser executable path and whether it came from
explicit configuration or fixed-location discovery; never record an account identifier or passkey
material.

1. Start signed out on a clean launcher profile. Prove that embedded sign-in remains the default and
   that no external browser starts until **Passkey sign in** is explicitly selected.
2. Select **Passkey sign in**. When an absolute supported Chrome/Chromium executable is configured,
   prove that exact executable starts and no fallback is substituted. Otherwise, prove that the
   same platform Google Chrome default later persisted by setup starts. Prove that the process uses
   a new launcher-owned `login-profile-*` directory rather than the user's normal browser profile.
   During credential and passkey entry, prove that this first process has no remote-debugging pipe
   or port and does not report a managed automation surface.
3. Complete the passkey challenge and confirm that the Temporary Chat composer is visible. Return
   to the launcher and select **I'm signed in — Continue**. Prove that the continuation command is
   accepted only by the active authorized browser-login child, that only its exact normal-browser
   child closes, and that capture does not begin until that process has exited. Repeat once by
   manually closing the dedicated browser and prove that this remains a supported path.
4. Prove that the launcher reopens only the same isolated profile under its owned
   `--remote-debugging-pipe`, with no browser-level TCP debugging listener. This managed capture
   phase may report `navigator.webdriver`; it must run headlessly with every request fulfilled
   locally. Prove that no ChatGPT or identity-provider endpoint is contacted, that only the locally
   fulfilled canonical ChatGPT origin is used to expose profile-backed local storage, and that the
   sanitized state contains at least one allowed ChatGPT/OpenAI cookie. Prove that the capture
   process closes automatically and the `login-profile-*` directory is gone before capture
   completes. Do not treat the version-3 capture marker as authentication proof.
5. Prove that the Electron partition does not become ready until the sanitized import independently
   reaches the same exact Temporary Chat, visible composer, and valid server session. Record the
   redacted `browser.system_login_imported`/ready evidence, not the session response or stored state.
6. Confirm the launcher-owned `transfer-*` directory, temporary browser profile, stdin control
   channel, and owned debugging pipe are gone after the Electron proof. Repeat once by continuing
   before authentication and prove that Electron verification fails explicitly, leaves Electron
   signed out, and removes both temporary profile and transfer directories.
7. Run **Run browser smoke test** through the imported Electron session. Record that it selected
   **High**, completed one Temporary Chat turn, returned exactly `CODEX WEB GPT READY`, and emitted
   `smoke.completed`. A ready setup screen without this turn evidence does not pass the gate.

Any managed-network request, missing Electron Temporary Chat/server-session proof, capture beginning
before the normal login browser exits, residual profile/transfer/control state, partial Electron
login after failure, or missing smoke evidence blocks the passkey claim for that platform.

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
