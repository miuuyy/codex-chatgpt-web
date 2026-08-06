const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const i18nSource = fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8");

test("launcher uses native macOS chrome and controlled window translucency", () => {
  assert.match(electronMain, /backgroundColor:\s*isMac\s*\?\s*"#00000000"\s*:\s*"#181818"/);
  assert.match(electronMain, /titleBarStyle:\s*isMac\s*\?\s*"hiddenInset"\s*:\s*"hidden"/);
  assert.match(electronMain, /titleBarOverlay:\s*\{[\s\S]*?height:\s*46/);
  assert.match(electronMain, /transparent:\s*isMac/);
  assert.match(electronMain, /vibrancy:\s*"under-window"/);
  assert.match(electronMain, /trafficLightPosition:\s*\{\s*x:\s*16,\s*y:\s*17\s*\}/);
  assert.doesNotMatch(electronMain, /setWindowButtonVisibility/);
  assert.doesNotMatch(appSource, /WindowControls/);
  assert.match(styles, /backdrop-filter/);

  for (const removedClass of [
    "ambient-backdrop",
    "onboarding-card",
    "control-panel",
    "status-bar",
    "browser-slot",
    "mcp-card",
    "diagnostic-card",
  ]) {
    assert.equal(appSource.includes(removedClass), false, `${removedClass} returned to App.tsx`);
    assert.equal(styles.includes(`.${removedClass}`), false, `${removedClass} returned to styles.css`);
  }
});

test("launcher retains the native shell and owned browser surface structure", () => {
  for (const requiredClass of [
    "app-titlebar",
    "app-sidebar",
    "sidebar-brand-row",
    "workspace",
    "browser-tab-strip",
    "browser-toolbar",
    "browser-viewport",
    "content-surface",
    "mcp-stage",
  ]) {
    assert.equal(appSource.includes(requiredClass), true, `${requiredClass} is missing from App.tsx`);
    assert.equal(styles.includes(`.${requiredClass}`), true, `${requiredClass} is missing from styles.css`);
  }
  assert.equal(appSource.includes("sidebar-resize-handle"), false);
  assert.equal(styles.includes(".sidebar-resize-handle"), false);
});

test("browser tabs remain clickable beneath the frameless window chrome", () => {
  assert.match(appSource, /className="app-titlebar draggable"/);
  assert.match(
    styles,
    /\.app-shell:has\(\.browser-surface\) \.app-titlebar\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
  assert.match(appSource, /className="browser-tab-drag draggable"/);
  assert.match(appSource, /className="browser-tab-strip"/);
  assert.match(appSource, /role="tablist"/);
  assert.match(appSource, /tabIndex=\{tab\.active \? 0 : -1\}/);
});

test("browser tabs remain reachable when the strip contains many sessions", () => {
  assert.match(styles, /\.browser-tab-strip\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(styles, /\.browser-tab-strip\s*\{[^}]*overflow-y:\s*hidden/s);
  assert.match(appSource, /activeRight - tabStrip\.clientWidth/);
  assert.match(appSource, /new ResizeObserver\(revealActiveTab\)/);
  assert.match(appSource, /event\.key === "ArrowLeft"/);
  assert.match(appSource, /event\.key === "ArrowRight"/);
  assert.match(appSource, /event\.key === "Home"/);
  assert.match(appSource, /event\.key === "End"/);
  assert.match(appSource, /tabIndex=\{tab\.active \? 0 : -1\}\s+title=\{copy\.hideTab\}/);
});

test("embedded ChatGPT is measured after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("launcher keeps browser chrome flush and MCP instructions below the video", () => {
  assert.match(styles, /\.workspace\s*\{[^}]*padding-top:\s*0/s);
  assert.match(styles, /\.content-surface\s*\{[^}]*padding-top:\s*var\(--height-titlebar\)/s);
  assert.match(styles, /\.mcp-stage\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(
    styles,
    /\.guide-media\s*\{[^}]*width:\s*min\(90%,\s*clamp\(511px,\s*44vw,\s*620px\)\)[^}]*aspect-ratio:\s*16\s*\/\s*9[^}]*overflow:\s*hidden/s,
  );
  assert.match(styles, /\.guide-media img\s*\{[^}]*object-fit:\s*contain/s);
  assert.doesNotMatch(styles, /\.wizard-stepper\s*\{[^}]*border-(?:top|bottom)/s);
  assert.match(appSource, /M22\.2819 9\.8211/);
  assert.match(appSource, /sidebar-brand-identity/);
});

test("Windows chrome uses the available left edge and the branded application icon", () => {
  assert.match(appSource, /data-platform=\{snapshot\.platform\}/);
  assert.match(styles, /\.app-root:not\(\[data-platform="darwin"\]\) \.titlebar-left\s*\{[^}]*left:\s*8px/s);
  assert.match(styles, /\.app-root:not\(\[data-platform="darwin"\]\) \.titlebar-left \.icon-button\s*\{[^}]*border-radius:\s*var\(--radius-round\)/s);
  assert.match(styles, /\.app-root:not\(\[data-platform="darwin"\]\) \.welcome-top\s*\{[^}]*padding-left:\s*20px/s);
  assert.match(electronMain, /icon:\s*APP_ICON_PATH/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
  assert.match(i18nSource, /keepRunningOnClose: "Keep server running when window closes"/);
});

test("settings expose a persistent fail-closed Codex bridge switch and status indicator", () => {
  assert.match(appSource, /api!\.setBridgeEnabled\(enabled\)/);
  assert.match(appSource, /snapshot\.state\.bridgeEnabled \? "success" : "error"/);
  assert.match(appSource, /body=\{copy\.bridgeRouteBody\} label=\{copy\.bridgeRoute\}/);
  assert.match(styles, /\.action-dot\.is-success\s*\{[^}]*background:\s*var\(--green-300\)/s);
  assert.match(styles, /\.action-dot\.is-error\s*\{[^}]*background:\s*var\(--red-300\)/s);
  assert.match(electronMain, /runtimeHost\.setBridgeEnabled\(enabled === true\)/);
  assert.match(electronMain, /codexRestartRequired:\s*true/);
  assert.match(i18nSource, /Turning it off restores your previous model route without deleting setup or saved credentials/);
});

test("settings use a dark custom language menu and quiet native scrollbars", () => {
  assert.doesNotMatch(appSource, /<select/);
  assert.match(appSource, /className="language-menu-panel"/);
  assert.match(styles, /\.language-menu-panel\s*\{[^}]*background:\s*var\(--color-background-elevated\)/s);
  assert.match(styles, /\*::\-webkit-scrollbar-button\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.content-scroll:hover::\-webkit-scrollbar-thumb\s*\{/);
});

test("completed social actions preserve their service icon without the blue active state", () => {
  assert.match(appSource, /is-social\$\{complete \? " is-complete" : ""\}/);
  assert.match(appSource, /<span><Icon name=\{icon\} \/><\/span>/);
  assert.doesNotMatch(appSource, /complete \? "check" : icon/);
  assert.match(styles, /\.welcome-option\.is-social\.is-complete > span:first-child\s*\{[^}]*color:\s*var\(--color-icon-secondary\)/s);
  assert.match(styles, /\.welcome-option\.is-social\.is-complete > svg\s*\{[^}]*color:\s*var\(--color-text-success\)/s);
  assert.match(styles, /\.welcome-option\.is-active > span:first-child\s*\{[^}]*color:\s*var\(--color-text-success\)/s);
});

test("MCP guide uses the two optimized recordings in the requested step order", () => {
  assert.match(
    appSource,
    /MCP_GUIDE_MEDIA = \[\s*new URL\("\.\/assets\/mcp-create-tunnel\.gif"[\s\S]*?new URL\("\.\/assets\/mcp-connect-connector\.gif"[\s\S]*?new URL\("\.\/assets\/mcp-connect-connector\.gif"/,
  );
  for (const file of ["mcp-create-tunnel.gif", "mcp-connect-connector.gif"]) {
    const asset = fs.readFileSync(path.join(launcherRoot, "src", "assets", file));
    assert.equal(asset.subarray(0, 6).toString("ascii"), "GIF89a");
    assert.ok(asset.length < 5 * 1024 * 1024, `${file} is unexpectedly large`);
  }
});

test("MCP copy includes every required account, key, and connector instruction", () => {
  assert.match(i18nSource, /regular API key with Tunnels Read \+ Use \(free;/);
  assert.match(i18nSource, /same OpenAI account that will use the ChatGPT plugin/);
  assert.match(i18nSource, /enable Developer Mode[\s\S]*?choose Tunnel[\s\S]*?set Authentication to None/);
  assert.match(appSource, /<NoticeRow icon="alert" tone="warning">/);
  assert.doesNotMatch(appSource, /icon="spark"/);
});

test("MCP wizard remains locked while a local or supervisor operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
  assert.match(appSource, /disabled=\{busy\} onClick=\{\(\) => void safeMove\(1\)\}/);
  assert.doesNotMatch(appSource, /connectorOpened/);
});

test("MCP wizard reuses saved credentials and exposes replacement explicitly", () => {
  assert.match(electronMain, /mcpCredentialsConfigured:\s*runtimeHost\?\.mcpCredentialsConfigured\(\)\s*\?\?\s*false/);
  assert.match(appSource, /credentialsConfigured && !replacingCredentials/);
  assert.match(appSource, /\{ replace: false \}/);
  assert.match(appSource, /\{ tunnelId, runtimeKey, replace: true \}/);
  assert.match(i18nSource, /replaceCredentials: "Replace credentials"/);
});

test("MCP verification has one primary action and exposes live progress", () => {
  assert.doesNotMatch(
    appSource,
    /<SecondaryButton disabled=\{busy \|\| !connectorOpened\} onClick=\{\(\) => void verify\(\)\}>/,
  );
  assert.match(appSource, /<PrimaryButton\s+disabled=\{busy\}/);
  assert.match(appSource, /onClick=\{\(\) => void \(doctor\?\.ok \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
  assert.match(
    electronMain,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
  assert.doesNotMatch(
    browserHostSource,
    /querySelectorAll\('\[role="group"\], \[role="option"\], \[role="menuitem"\]'\)/,
  );
});

test("launcher refreshes persisted ChatGPT authentication before presenting setup", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
  assert.match(i18nSource, /checkingSignIn: "Checking saved session"/);
});
