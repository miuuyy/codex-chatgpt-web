const { contextBridge, ipcRenderer } = require("electron");

function subscription(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("codexWebLauncher", {
  snapshot: () => ipcRenderer.invoke("launcher:snapshot"),
  setLanguage: (language) => ipcRenderer.invoke("launcher:set-language", language),
  openSocial: (target) => ipcRenderer.invoke("launcher:open-social", target),
  completeOnboarding: (language) => ipcRenderer.invoke("launcher:complete-onboarding", language),
  openExternal: (url) => ipcRenderer.invoke("launcher:open-external", url),
  setBrowserBounds: (bounds) => ipcRenderer.invoke("launcher:browser-bounds", bounds),
  setBrowserSurfaceActive: (active) => ipcRenderer.invoke("launcher:browser-surface-active", active),
  showBrowser: () => ipcRenderer.invoke("launcher:browser-show"),
  hideBrowser: () => ipcRenderer.invoke("launcher:browser-hide"),
  navigateBrowser: (action) => ipcRenderer.invoke("launcher:browser-navigate", action),
  zoomBrowser: (action) => ipcRenderer.invoke("launcher:browser-zoom", action),
  selectBrowserTab: (tabId) => ipcRenderer.invoke("launcher:browser-tab-select", tabId),
  closeBrowserTab: (tabId) => ipcRenderer.invoke("launcher:browser-tab-close", tabId),
  openLogin: () => ipcRenderer.invoke("launcher:browser-login"),
  logoutChatGpt: () => ipcRenderer.invoke("launcher:browser-logout"),
  dismissSessionReminder: () => ipcRenderer.invoke("launcher:session-reminder-dismiss"),
  smokeTest: () => ipcRenderer.invoke("launcher:browser-smoke"),
  verifyMcp: () => ipcRenderer.invoke("launcher:mcp-verify"),
  doctor: () => ipcRenderer.invoke("launcher:doctor"),
  cancelTurns: () => ipcRenderer.invoke("launcher:cancel-turns"),
  setBridgeEnabled: (enabled) => ipcRenderer.invoke("launcher:bridge-enabled", enabled),
  uninstallIntegration: () => ipcRenderer.invoke("launcher:uninstall-integration"),
  setupCore: () => ipcRenderer.invoke("launcher:setup-core"),
  setupMcp: (input) => ipcRenderer.invoke("launcher:setup-mcp", input),
  installExternalProvider: (input) => ipcRenderer.invoke("launcher:external-provider-install", input),
  dismissExternalProviderInstall: () => ipcRenderer.invoke("launcher:external-provider-dismiss"),
  uninstallExternalProvider: () => ipcRenderer.invoke("launcher:external-provider-uninstall"),
  setMcpStep: (step) => ipcRenderer.invoke("launcher:set-mcp-step", step),
  setAutostart: (enabled) => ipcRenderer.invoke("launcher:autostart", enabled),
  setPreference: (key, value) => ipcRenderer.invoke("launcher:set-preference", key, value),
  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),
  logs: (limit) => ipcRenderer.invoke("launcher:logs", limit),
  exportLogs: () => ipcRenderer.invoke("launcher:export-logs"),
  installUpdate: () => ipcRenderer.invoke("launcher:update-install"),
  windowState: () => ipcRenderer.invoke("launcher:window-state"),
  windowControl: (action) => ipcRenderer.send("launcher:window-control", action),
  onWindowStateChanged: (listener) => subscription("launcher:window-state-changed", listener),
  onStateChanged: (listener) => subscription("launcher:state-changed", listener),
  onBrowserState: (listener) => subscription("launcher:browser-state", listener),
  onOperation: (listener) => subscription("launcher:operation", listener),
  onLog: (listener) => subscription("launcher:log", listener),
  onUpdateState: (listener) => subscription("launcher:update-state", listener),
  onExternalProviderInstall: (listener) => subscription("launcher:external-provider-request", listener),
});
