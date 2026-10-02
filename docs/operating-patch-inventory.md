# Operating patch integration inventory

The preserved 6.1.4 operating CLI was compared against its original 381d78c build.
The compiled diff has 24 regions. This inventory describes behavior rather than copying
compiled code, account information or credentials.

| Region | Operating change | Source disposition |
| --- | --- | --- |
| 1 | Fixed full-permission and always-active goal claims | Keep real execution authority and explicit goal activation |
| 2 | Window tool in bridge names | Integrate optional `observe_window` |
| 3 | External head/tail output module | Integrate UTF-8 shared output budget |
| 4 | External window capture module | Ship cancellable helper and C# asset |
| 5 | Ignore final Markdown consistency failure | Restore strict validation |
| 6 | Remove committed text/order/link checks | Restore strict validation |
| 7 | Remove source-range overlap check | Restore strict validation |
| 8 | Ignore final DOM prefix mismatch | Restore strict validation |
| 9 | Accept missing or arbitrary Korean effort labels | Keep exact effort evidence |
| 10 | Korean personalized button | Add exact localized labels |
| 11 | Korean unpersonalized button | Add exact localized labels |
| 12 | Korean personalized menu choice | Add localized choice scoped to the owned menu |
| 13 | Lower unavailable effort index | Remove downgrade |
| 14 | Alternate effort downgrade branch | Remove downgrade |
| 15 | Allow every same-origin verification URL | Keep owned URL proof |
| 16 | Alternate same-origin URL bypass | Keep owned URL proof |
| 17 | Global latest-message React completion override | Bind private evidence to current assistant message; retain DOM fence |
| 18 | Hidden connector text accepted | Require visible evidence |
| 19 | Loose connector name matching | Keep exact owned connector matching |
| 20 | Return thread environment before current validation | Keep current-turn validation and captured preflight identity |
| 21 | Unawaited external goal evaluator after HTTP completion | Integrate bounded telemetry; await explicit DEV goal decisions |
| 22 | External DEV status hook | Built-in dashboard telemetry |
| 23 | External DEV compaction hook | Built-in completion/compaction telemetry |
| 24 | Consume queued DEV goal before asking the user | Integrate explicit, cancellable, durable bounded loop |

The reusable CoS window, output, goal and dashboard modules now live under `src/cos`.
Private evaluator configuration and credentials stay in the selected profile. The
original operating modules remain in the local pre-installation backup, not the PR.
