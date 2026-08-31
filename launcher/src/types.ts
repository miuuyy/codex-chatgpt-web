export type Language = "en" | "zh-CN" | "ja";
export type LauncherProfile = "production" | "development";
export type Surface = "chat" | "setup" | "mcp" | "activity" | "settings";

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  autoConnectMcp: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  experimentalBiggerContext: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  mcpSetupComplete?: boolean;
  mcpRuntimeInstalled?: boolean;
  codexRestartRequired?: boolean;
  mcpGuideStep: number;
  mcpConnectorName: string | null;
  mcpTunnelKind: "openai" | "cloudflare" | null;
  sessionRefreshReminderAt: string | null;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  activeTabId: string;
  maxTabs: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
}

export interface LogRecord {
  at: string;
  level: "debug" | "info" | "warning" | "error";
  event: string;
  detail: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export interface McpConnectionState {
  active: boolean;
  status: "checking" | "connecting" | "connected" | "disconnecting" | "disconnected" | "unavailable" | "error";
  detail: string;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  profile: LauncherProfile;
  profilePaths: {
    coreHome: string;
    codexHome: string;
    userData: string;
  };
  state: LauncherState;
  browser: BrowserState | null;
  connectorName: string;
  mcpCredentialsConfigured: boolean;
  mcpCredentials: Record<"openai" | "cloudflare", boolean>;
  cloudflare: CloudflareSetup;
  logs: LogRecord[];
  urls: {
    github: string;
    x: string;
    connectors: string;
    tunnels: string;
    keys: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  operation: OperationState | null;
  connection: McpConnectionState;
  update: UpdateState;
}

export interface CloudflareSetup {
  kind: "openai" | "cloudflare";
  binaryPath: string;
  hostname: string;
  publicUrl: string;
  registrationUrl: string;
  authorizationPassphrase: string;
  config: {
    path: string;
    exists: boolean;
    hostnames: string[];
    error: string | null;
  };
}

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  doctor(): Promise<DoctorReport>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setupMcp(input: {
    appName: string;
    tunnelKind: "openai" | "cloudflare";
    tunnelId?: string;
    runtimeKey?: string;
    cloudflareHostname?: string;
    replace?: boolean;
  }): Promise<{ ok: boolean; stdout: string; cloudflare?: CloudflareSetup }>;
  pickCloudflareConfig(): Promise<CloudflareSetup>;
  pickCloudflaredBinary(): Promise<CloudflareSetup>;
  setMcpStep(step: number): Promise<LauncherState>;
  setMcpPreferences(input: {
    connectorName: string;
    tunnelKind: "openai" | "cloudflare";
  }): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setBiggerContext(enabled: boolean): Promise<LauncherState>;
  setPreference(
    key: "autoConnectMcp" | "keepRunningOnClose" | "showBrowserDuringTurns",
    value: boolean,
  ): Promise<LauncherState>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  logs(limit?: number): Promise<LogRecord[]>;
  exportLogs(destination: "clipboard" | "file"): Promise<string | null>;
  clearLogs(): Promise<{ cleared: boolean; logs: LogRecord[] }>;
  setMcpConnection(active: boolean): Promise<McpConnectionState>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onMcpConnection(listener: (state: McpConnectionState) => void): () => void;
  onLog(listener: (record: LogRecord) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
