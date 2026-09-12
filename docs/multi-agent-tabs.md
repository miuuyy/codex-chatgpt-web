# Separate ChatGPT tabs

The launcher can host up to ten task tabs in one owned, signed-in browser
partition. Automatic helpers already receive their own tab and surface through
the existing turn-lease protocol.

## New chat tab

In automatic interaction mode, click **New chat tab** in the tab strip to open
a separate temporary conversation using the same login. This is session reuse,
not a copy or branch of another conversation. It does not copy a task lease,
connector binding, prompt, or existing chat history.

User-opened tabs count toward the existing ten-tab limit, remain open until
closed, and are excluded from automatic lease expiry and retained-tab eviction.
An idle selected tab can be navigated while a different agent's tab is running.
Navigation of a running task's own tab remains locked.

Background automatic turns do not switch the selected tab while the browser is
visible unless show-browser-during-turns is enabled. Completion of an automatic
turn does not hide a selected user-opened tab.

## Concurrent agents

Keep using the authenticated launcher turn API for automated work:

1. Each agent starts its own turn with a unique trace ID and its actual helper PID.
2. Use only the returned surface ID and tab ID, not the currently selected tab.
3. Heartbeat that lease while working, and end only that agent's own turn.
4. Use distinct conversation keys for independent tasks and separate output paths.
5. Respect the ten-tab limit; callers must wait or report capacity exhaustion.

The New chat tab button is for user-managed conversations. It does not assign
a human-opened tab to an agent or introduce an agent scheduler. Automatic agents
continue to allocate their own owned tabs through the existing API.

Tabs share account cookies, site storage, account limits, and profile-wide
settings. They are not separate security identities or isolated browser profiles.
ChatGPT can restore shared new-chat drafts; agents must preserve the existing
draft guard rather than clear an unfamiliar draft. Do not run two writers against
the same saved conversation, or change login/session settings while tasks run.
The new UI control is disabled in Zero Risk/manual mode.

## Future work

Multi-account support is intentionally out of scope for this change. It would
require explicit account/profile selection and separate authenticated browser
partitions rather than sharing the current launcher session.

## Delivery

These are source changes and are not installed into the running AppImage.
Deploy or restart the launcher only when its active users agree.
