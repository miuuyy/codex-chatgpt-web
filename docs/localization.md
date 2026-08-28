# Launcher localization

This file is the canonical map for launcher language support. Check it before searching the repository again.

## Supported languages

| Language | Code | Display name | Onboarding marker |
| --- | --- | --- | --- |
| English | `en` | English | `EN` |
| Simplified Chinese | `zh-CN` | 简体中文 | `简` |
| Japanese | `ja` | 日本語 | `日` |

## Source of truth

- `launcher/src/types.ts` defines the renderer `Language` union.
- `launcher/src/i18n.ts` owns all renderer copy. Every non-English dictionary is typed as
  `Record<keyof typeof en, string>`, so `launcher:typecheck` detects missing keys.
- `launcher/src/App.tsx` wires the onboarding choices and the Settings language menu.
- `launcher/electron/state.cjs` owns the persisted-language allowlist and repairs unsupported saved values.
- `launcher/electron/main.cjs` applies the same allowlist to IPC writes and localizes native launcher surfaces that
  have language-specific copy.
- `launcher/tests/i18n.test.cjs` verifies dictionary parity, Japanese terminology, and renderer/Electron wiring.
- `launcher/tests/state.test.cjs` verifies save, reload, and repair behavior.

Language changes are persisted in `launcher-state.json`, emitted through `launcher:state-changed`, and applied by
React immediately. Existing version-1 state files remain compatible; `null` still means that onboarding has not yet
chosen a language.

## Translation boundaries

Translate user-facing launcher instructions, labels, warnings, and native confirmation text. Keep product names,
model slugs, event names, error codes, trace IDs, JSON/config keys, CLI output, and other machine-consumed values
unchanged. ChatGPT DOM automation is independent of launcher localization: do not make selectors in
`src/chatgpt-session.ts` or `src/adapters/chatgpt-web/` depend on translated text.

The current effort-control compatibility selectors in `src/chatgpt-session.ts`, including generic
`aria-haspopup="menu"` and `aria-haspopup="listbox"` fallbacks, are required for current ChatGPT Web High,
Extra High, and Pro routing and must be preserved.

## Verification

Run at least:

```bash
bun run launcher:typecheck
bun run launcher:test
bun run verify
```

For a UI change, also launch with `bun run app`, switch languages in onboarding and Settings, inspect Setup,
Browser, MCP, Activity, dialogs, and long copy, then restart the launcher to verify persistence.
