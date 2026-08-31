const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const stylesSource = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("native clicks reach the original ChatGPT browser surface instead of the window drag region", () => {
  assert.match(appSource, /draggable=\{surface !== "chat"\}/);
  assert.match(appSource, /className=\{`app-titlebar\$\{draggable \? " draggable" : ""\}`\}/);
  assert.match(appSource, /className=\{`browser-tab\$\{tab\.active \? " is-active" : ""\}`\}/);
  assert.match(appSource, /<div className="browser-viewport" ref=\{browserSlotRef\}>/);
});

test("Chat, Activity, and Settings share the launcher-native state", () => {
  assert.match(appSource, /function BrowserSurface\(/);
  assert.match(appSource, /snapshot\.state\.coreSetupComplete && snapshot\.state\.codexCatalogVerified \? "chat" : "setup"/);
  assert.doesNotMatch(appSource, /HomeSurface|surface === "home"/);
  assert.match(appSource, /const \[filter, setFilter\] = useState<"all" \| "warning" \| "error">\("all"\)/);
  assert.match(appSource, /className="settings-card diagnostics-card"/);
  assert.doesNotMatch(appSource, /chrome\.runtime|chrome\.storage/);
});

test("Chat stays the original embedded ChatGPT surface without a duplicate session-history page", () => {
  assert.match(appSource, /function BrowserSurface\(/);
  assert.match(appSource, /className="browser-tab-strip"/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
  assert.doesNotMatch(appSource, /SessionHistorySurface|surface === "sessions"|api!\.sessions|api!\.session/);
  assert.doesNotMatch(preloadSource, /"launcher:sessions"|"launcher:session"/);
  assert.doesNotMatch(electronMain, /"launcher:sessions"|"launcher:session"/);
});

test("renderer zoom scales the shell without moving or zooming the native ChatGPT surface", () => {
  assert.match(
    electronMain,
    /browserHost\?\.setBounds\(validateBounds\(bounds\), event\.sender\.getZoomFactor\(\)\)/,
  );
  assert.match(browserHostSource, /this\.bindShellZoomShortcuts\(this\.window\.webContents\)/);
  assert.match(browserHostSource, /contents\.setZoomLevel\(next\)/);
  assert.match(appSource, /api!\.zoomBrowser\(action\)/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  assert.match(
    electronMain,
    /runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/,
  );
  const persist = electronMain.indexOf("await browserHost?.persistSession()");
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("DEV launcher exposes its profile and supervises only its Full-mode MCP runtime", () => {
  assert.match(electronMain, /profile:\s*LAUNCHER_PROFILE\.kind/);
  assert.match(electronMain, /if \(IS_DEV_PROFILE\) \{[\s\S]*?config\?\.mode === "full"[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?\} else \{[\s\S]*?void \(async \(\) => \{/);
  assert.match(electronMain, /await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /packaged:\s*app\.isPackaged && !IS_DEV_PROFILE/);
  assert.match(electronMain, /IS_DEV_PROFILE && !stateStore\.read\(\)\.onboardingComplete/);
  assert.match(electronMain, /onboardingComplete:\s*true,[\s\S]*?autoStart:\s*false/);
  assert.match(appSource, /snapshot\.profile === "development"/);
  assert.match(appSource, /data-profile=\{snapshot\.profile\}/);
  assert.match(appSource, /<SettingRow body=\{copy\.biggerContextBody\} label=\{copy\.biggerContext\}>/);
  assert.match(appSource, /api!\.setBiggerContext\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBiggerContext\(enabled === true\)/);
  assert.doesNotMatch(electronMain, /IS_DEV_PROFILE && key === "experimentalBiggerContext"/);
});

test("Bigger Context startup recommendation reuses the persisted setting and setup transaction", () => {
  assert.match(
    appSource,
    /const \[biggerContextRecommendationOpen, setBiggerContextRecommendationOpen\] = useState\(\s*snapshot\.state\.coreSetupComplete === true && !snapshot\.state\.experimentalBiggerContext,/,
  );
  assert.match(appSource, /&& !biggerContextRecommendationOpen;/);
  assert.match(appSource, /updateState\(await api!\.setBiggerContext\(enabled\)\)/);
  assert.match(
    appSource,
    /<BiggerContextRecommendation[\s\S]*?checked=\{snapshot\.state\.experimentalBiggerContext\}[\s\S]*?onClose=\{\(\) => setBiggerContextRecommendationOpen\(false\)\}/,
  );
  assert.match(appSource, /<Switch checked=\{checked\} disabled=\{busy\} onChange=\{onChange\} \/>/);
  assert.match(stylesSource, /\.bigger-context-recommendation-backdrop\s*\{[^}]*position:\s*fixed;/s);
  assert.doesNotMatch(stylesSource, /\.bigger-context-recommendation-backdrop\s*\{[^}]*backdrop-filter:/s);
  assert.match(stylesSource, /\.bigger-context-recommendation\s*\{[^}]*width:\s*min\(400px, 100%\);[^}]*padding:\s*18px;/s);
});

test("MCP surfaces use the official local protocol mark", () => {
  assert.match(appSource, /function McpMark\(\) \{\s*return <i aria-hidden="true" className="mcp-mark" \/>;\s*\}/);
  assert.match(appSource, /icon === "mcp" \? <McpMark \/> : <Icon name=\{icon\} \/>/);
  assert.match(appSource, /<McpMark \/>[\s\S]*?copy\.mcpTitle/);
  assert.doesNotMatch(appSource, /<Icon name="mcp" \/>/);
  assert.match(stylesSource, /mask:\s*url\("\.\.\/assets\/mcp-mark\.svg"\)/);
});

test("Cloudflare file authority stays in main-process pickers", () => {
  assert.match(electronMain, /launcher:pick-cloudflare-config/);
  assert.match(electronMain, /launcher:pick-cloudflared-binary/);
  assert.doesNotMatch(electronMain, /input\?\.cloudflareConfigPath/);
  assert.doesNotMatch(electronMain, /input\?\.cloudflaredBinaryPath/);
  assert.match(appSource, /pickCloudflareConfig\(\)/);
  assert.match(appSource, /pickCloudflaredBinary\(\)/);
  assert.match(appSource, /await reconnectCloudflare\(nextHostname\)/);
  assert.match(appSource, /reconnectCloudflare\(cloudflareHostname\)/);
});

test("the configured launcher exposes no persistent bridge opt-out", () => {
  assert.doesNotMatch(appSource, /setBridgeEnabled|bridgeRouteBody/);
  assert.doesNotMatch(preloadSource, /launcher:bridge-enabled|setBridgeEnabled/);
  assert.doesNotMatch(electronMain, /launcher:bridge-enabled|bridge-disabled|bridgeEnabled/);
  assert.match(electronMain, /runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?runtimeHost\.connectBridgeRoute\(\)/);
});

test("the title bar connection control mirrors the live Codex bridge route", () => {
  assert.match(preloadSource, /setBridgeConnection:\s*\(active\)[\s\S]*?launcher:bridge-set-active/);
  assert.match(preloadSource, /onBridgeConnection:[\s\S]*?launcher:bridge-connection/);
  assert.match(electronMain, /connection:\s*bridgeConnection/);
  assert.match(
    electronMain,
    /launcher:bridge-set-active[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?runtimeHost\.connectBridgeRoute\(\)[\s\S]*?runtimeHost\.restoreBridgeRoute\("bridge-disconnect"\)/,
  );
  assert.match(appSource, /copy\.bridgeConnected[\s\S]*?copy\.bridgeDisconnect[\s\S]*?className="titlebar-connection no-drag"/);
  assert.match(stylesSource, /\.titlebar-connection\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*110;[^}]*top:\s*9px;/s);
  assert.match(stylesSource, /\.titlebar-power\.is-running\s*\{[^}]*color:\s*var\(--red-300\);/s);
});

test("MCP connection is available independently of model catalog verification", () => {
  assert.match(appSource, /<button className="next-surface-row" onClick=\{showMcp\}/);
  assert.match(appSource, /\{copy\.mcpStepTwoHint\}/);
  assert.doesNotMatch(appSource, /\|\| !snapshot\.state\.codexCatalogVerified/);
  assert.doesNotMatch(appSource, /mcpCatalogRequired/);
});

test("MCP navigation remains locked while an operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
});

test("MCP connector name and tunnel kind survive failed connection attempts", () => {
  assert.match(preloadSource, /setMcpPreferences:[\s\S]*?launcher:set-mcp-preferences/);
  assert.match(electronMain, /persistMcpPreferences\(\{ connectorName, tunnelKind \}\)[\s\S]*?const result = await setup/);
  assert.match(appSource, /snapshot\.state\.mcpConnectorName \|\| snapshot\.connectorName/);
  assert.match(appSource, /snapshot\.state\.mcpTunnelKind \|\| snapshot\.cloudflare\.kind/);
  assert.match(appSource, /onBlur=\{\(\) => void persistPreferences\(\)/);
  assert.match(appSource, /persistPreferences\(connectorName, next\)/);
  assert.match(electronMain, /getConnectorName: \(\) => \{[\s\S]*?runtimeHost\.mcpConnectorName\(\)[\s\S]*?stateStore\.read\(\)\.mcpConnectorName \|\| runtimeHost\.browserConnectorName\(\)/);
});

test("MCP connector instructions show every required ChatGPT field", () => {
  assert.match(appSource, /copy\.connectorName/);
  assert.match(appSource, /copy\.connectorUrl/);
  assert.match(appSource, /copy\.authentication[\s\S]*?copy\.authenticationOAuth[\s\S]*?copy\.authenticationNone/);
  assert.match(appSource, /copy\.registrationUrl[\s\S]*?cloudflare\.registrationUrl/);
  assert.match(appSource, /copy\.authorizationPassphrase[\s\S]*?cloudflare\.authorizationPassphrase/);
  assert.match(appSource, /copy\.permissions[\s\S]*?copy\.allowAllActions/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("Settings diagnostics distinguish health, maintenance, and destructive actions", () => {
  assert.match(appSource, /diagnostic-row is-primary[\s\S]*?copy\.runDoctorBody[\s\S]*?<DoctorSummary/);
  assert.match(appSource, /diagnostic-row\$\{turnsCancelled[\s\S]*?turnsCancelled \? "check" : "close"/);
  assert.match(appSource, /diagnostic-row is-danger\$\{integrationRemoved[\s\S]*?integrationRemoved \? "check" : "trash"/);
});

test("launcher shares only privacy-safe exported diagnostics", () => {
  assert.match(appSource, /api!\.exportLogs\(destination\)/);
  assert.match(appSource, /exportLogs\("clipboard"\)/);
  assert.match(appSource, /exportLogs\("file"\)/);
  assert.match(preloadSource, /exportLogs:\s*\(destination\)[\s\S]*?launcher:export-logs/);
  assert.match(electronMain, /launcher:export-logs[\s\S]*?clipboard\.writeText\(sanitized\.text\)/);
  assert.match(electronMain, /launcher:export-logs[\s\S]*?showSaveDialog[\s\S]*?exportSanitizedLogs/);
  assert.doesNotMatch(preloadSource, /launcher:open-logs/);
  assert.doesNotMatch(electronMain, /launcher:open-logs/);
});

test("Activity clears local logs only after native confirmation", () => {
  assert.match(preloadSource, /clearLogs:[\s\S]*?launcher:clear-logs/);
  assert.match(electronMain, /launcher:clear-logs[\s\S]*?showMessageBox[\s\S]*?logger\.clear\(\)/);
  assert.match(appSource, /activity-log-actions[\s\S]*?copy\.copySafeLog[\s\S]*?copy\.saveSafeLog[\s\S]*?copy\.clearLogs/);
  assert.match(appSource, /const result = await api!\.clearLogs\(\)[\s\S]*?setLogs\(result\.logs\)/);
});

test("Activity recent events expand to show their full structured detail", () => {
  assert.match(appSource, /<details className="activity-row"[\s\S]*?<summary>[\s\S]*?activity-row-chevron[\s\S]*?JSON\.stringify\(record\.detail, null, 2\)[\s\S]*?<\/details>/);
});

test("MCP verification failures stay inside the structured setup report", () => {
  assert.match(appSource, /next\.operation\.name !== "mcp-verification"/);
  assert.match(appSource, /next\.name !== "mcp-verification"/);
  assert.match(electronMain, /Finish the active Codex task before verifying the ChatGPT connector/);
  assert.match(electronMain, /report\.checks\.filter\(\(check\) => check\.id !== "connector"\)/);
  assert.match(electronMain, /mcp\.verification_requested/);
  assert.match(electronMain, /launcherFocused:\s*mainWindow\?\.isFocused\(\) === true/);
  assert.match(electronMain, /rendererFocused:\s*event\.sender\.isFocused\(\)/);
});

test("MCP verification proves runtime health before checking the connector", () => {
  const start = electronMain.indexOf('handle("launcher:mcp-verify"');
  const end = electronMain.indexOf('handle("launcher:doctor"', start);
  const handler = electronMain.slice(start, end);

  assert.ok(start >= 0 && end > start, "MCP verification handler must remain registered");
  assert.match(
    handler,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?if \(!report\.ok\)[\s\S]*?return report;[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  assert.match(handler, /publishOperation\(\{ name: operationName, status: "completed"/);
  assert.match(handler, /const connectorName = runtimeHost\.mcpConnectorName\(\);[\s\S]*?verifyConnector\(connectorName\)[\s\S]*?JSON\.stringify\(connectorName\)/);
  assert.match(appSource, /onClick=\{\(\) => void \(doctor\?\.ok \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
});

test("saved ChatGPT authentication is refreshed before setup is presented", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  const productionStartup = electronMain.indexOf("} else void (async () => {");
  const refreshBarrier = electronMain.indexOf("await startupAuthenticationRefresh", productionStartup);
  const upgrade = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()", productionStartup);
  const runtimeStart = electronMain.indexOf("runtimeSupervisor.startIfConfigured()", upgrade);
  const routeConnect = electronMain.indexOf("runtimeHost.connectBridgeRoute()", runtimeStart);
  assert.ok(refreshBarrier > productionStartup, "production startup must wait for saved-session refresh");
  assert.ok(upgrade > refreshBarrier, "runtime upgrade must not inspect the browser before refresh settles");
  assert.ok(runtimeStart > upgrade, "configured runtime must start after any upgrade");
  assert.ok(routeConnect > runtimeStart, "Codex route must connect only after the runtime is healthy");
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe", () => {
  assert.match(appSource, /<SetupRow[\s\S]*?onAction=\{install\}[\s\S]*?repeatable/);
  assert.match(appSource, /complete && !repeatable/);
  assert.match(
    electronMain,
    /!setupState\.coreSetupComplete[\s\S]*?smokePassedThisSession[\s\S]*?smokePassedForCurrentVersion\(setupState\)/,
  );
});

test("restoring the original Codex integration is available only in Settings", () => {
  assert.doesNotMatch(appSource, /restoreOriginal|onSecondaryAction|secondaryAction/);
  assert.equal(appSource.match(/api!\.uninstallIntegration\(\)/g)?.length, 1);
  assert.match(appSource, /function SettingsSurface\([\s\S]*?const uninstallIntegration = async \(\) =>/);
  assert.match(appSource, /copy\.uninstallIntegration/);
});

test("session reminders expose dismissal and a real storage-clearing logout", () => {
  assert.match(electronMain, /sessionRefreshReminderAt:\s*nextSessionRefreshReminderAt\(\)/);
  assert.match(electronMain, /launcher:session-reminder-dismiss/);
  assert.match(electronMain, /launcher:browser-logout[\s\S]*?browserHost\.logout\(\)/);
  assert.match(preloadSource, /dismissSessionReminder:[\s\S]*?launcher:session-reminder-dismiss/);
  assert.match(preloadSource, /logoutChatGpt:[\s\S]*?launcher:browser-logout/);
  assert.match(browserHostSource, /session\.clearStorageData\(\)/);
});
