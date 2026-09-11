# Automated Pro model selection

In **Settings → Automated Pro model**, choose **Follow ChatGPT** (the unchanged default),
**GPT-5.6 Sol Pro**, **GPT-5.5 Pro**, or **GPT-6 Astra Pro**. The setting only pins automated
Pro turns. It does not change other reasoning levels, Zero Risk's manual selection, context
limits, the Responses route, or the MCP tunnel.

The profile's canonical `config.json` stores the optional `proModelVersion` string as `"5.6"`,
`"5.5"`, or `"6"`. Choosing Follow removes the field. The launcher saves it through an
authenticated, idle-checked config command. The service snapshots the choice for each Pro request;
an in-flight request cannot switch versions halfway through.

The browser first selects the version, then moves the effort slider to Pro. Multipart preparation
stays on the selected version at its existing lower effort. Immediately before each send, the
browser rechecks the selected version and effort. Missing or changed controls fail without sending
the pending prompt or silently selecting another model. Selecting **Latest** for GPT-6 is not enough:
the slider must identify version 6, so a future Latest version cannot silently satisfy that pin.

## Browser evidence and reproducible checks

The following sanitized accessibility observations were captured on 2026-09-11 from an authenticated
ChatGPT model picker, without submitting a prompt or changing the selected version:

```text
effort slider: 6 Pro，第 5 项，共 5 项。 使用左右箭头键调整能力。
model selector: 选择模型
model options:
  最新          selected
  GPT-5.6 Sol   not selected
  GPT-5.5       not selected
```

The isolated DEV run also captured this DOM structure after selecting 5.6 (classes omitted and
generated IDs normalized):

```html
<div role="menuitem" aria-label="能力" aria-keyshortcuts="ArrowLeft ArrowRight"
     aria-describedby="picker-value picker-instructions">
  <div data-model-reasoning-effort-slider>
    <!-- Layout wrappers omitted. This numeric slider is hidden from accessibility. -->
    <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4"
          aria-valuenow="4"></span>
  </div>
</div>
<span id="picker-value">5.6 Pro，第 5 项，共 5 项。</span>
<span id="picker-instructions">使用左右箭头键调整能力。</span>
```

The version comes from the keyboard control's `aria-describedby` targets, **not** the hidden
slider's `aria-valuetext` (which is absent). `tests/fixtures/pro-model-picker.json` preserves these
observed attributes, option names, and descriptions without account data or generated IDs.

`tests/pro-model-selection.test.ts` models that fixture at the browser locator boundary and
exercises the actual selection and pre-send methods. It covers every pinned version,
missing options, mismatched version labels, a future Latest version, multipart preparation, and a
picker reset before submission. Run it with:

```bash
bun test tests/pro-model-selection.test.ts tests/model-contract.test.ts
```

The local tests use a DOM-derived locator test double, not a real ChatGPT connection. A separate
live check on 2026-09-11 used the working-tree DEV launcher on macOS with the Chinese ChatGPT UI:

- Selected **GPT-5.6 Sol Pro** through DEV Settings and verified `proModelVersion: "5.6"` persisted.
- The actual browser worker selected 5.6, verified Pro, rechecked immediately before submission,
  and completed one browser-only response: `PRO56_OK` (Markdown transport escaped the underscore).
- Initial preflight failures while correcting the description lookup stopped before sending.
- No GPT-5.5 or GPT-6 prompt was submitted; those branches have local regression coverage only.

This does not constitute live verification of other ChatGPT locales or models.

For a 5.6-only check, sign into the working-tree DEV launcher and initialize its browser-only
profile, choose **GPT-5.6 Sol Pro** in DEV Settings, then run:

```bash
bun run dev:chat pro-version-56-qa --model pro "Reply with exactly: PRO56_OK"
```

Do not use an unpinned smoke test when only one version is authorized. A browser-only DEV check
does not validate installed local-tool/MCP execution; this change preserves their existing routing
and capability contract rather than altering those mechanisms.
