import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyFor, type Copy } from "./i18n";
import { Icon, type IconName } from "./icons";
import type {
  BrowserState,
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
  LogRecord,
  OperationState,
  Surface,
} from "./types";

const api = window.codexWebLauncher;
const PANEL_TRANSITION = { duration: 0.3, ease: [0.16, 1, 0.3, 1] } as const;
const COMPACT_SIDEBAR_QUERY = "(max-width: 820px)";
const MCP_GUIDE_MEDIA = [
  new URL("./assets/mcp-create-tunnel.gif", import.meta.url).href,
  new URL("./assets/mcp-connect-connector.gif", import.meta.url).href,
  new URL("./assets/mcp-connect-connector.gif", import.meta.url).href,
] as const;

export function App() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      setBrowser(next.browser);
      setLogs(next.logs);
      setOperation(next.operation);
      if (next.operation?.status === "failed") setError(next.operation.message);
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribeState = api.onStateChanged((state) => {
      setSnapshot((current) => current
        ? {
            ...current,
            state,
            smokePassed: current.smokePassed
              || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
          }
        : current);
    });
    const unsubscribeBrowser = api.onBrowserState(setBrowser);
    const unsubscribeOperation = api.onOperation((next) => {
      setOperation(next);
      if (next.status === "failed") setError(next.message);
    });
    const unsubscribeLog = api.onLog((record) => setLogs((current) => [...current.slice(-299), record]));
    const unsubscribeUpdate = api.onUpdateState((update) => {
      setSnapshot((current) => current ? { ...current, update } : current);
    });
    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeBrowser();
      unsubscribeOperation();
      unsubscribeLog();
      unsubscribeUpdate();
    };
  }, []);

  const updateState = useCallback((state: LauncherState) => {
    setSnapshot((current) => current
      ? {
          ...current,
          state,
          smokePassed: current.smokePassed
            || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
        }
      : current);
  }, []);

  if (!api) return <FatalMessage message="Launcher IPC is unavailable." />;
  if (!snapshot) return <LaunchLoading />;

  const language = snapshot.state.language ?? "en";
  const copy = copyFor(language);

  return (
    <div className="app-root" data-language={language} data-platform={snapshot.platform} data-theme="dark">
      <AnimatePresence mode="wait">
        {!snapshot.state.onboardingComplete ? (
          <Onboarding
            key="onboarding"
            language={language}
            setError={setError}
            snapshot={snapshot}
            updateState={updateState}
          />
        ) : (
          <LauncherShell
            browser={browser}
            copy={copy}
            key="launcher"
            language={language}
            logs={logs}
            operation={operation}
            setError={setError}
            snapshot={snapshot}
            updateState={updateState}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {error ? <ErrorToast copy={copy} message={error} onDismiss={() => setError(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

function Onboarding({
  language,
  setError,
  snapshot,
  updateState,
}: {
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [stage, setStage] = useState<"language" | "support">(snapshot.state.language ? "support" : "language");
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(language);
  const [busy, setBusy] = useState(false);
  const localized = copyFor(selectedLanguage);
  const isLanguage = stage === "language";

  const chooseLanguage = async () => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setLanguage(selectedLanguage));
      setStage("support");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openSocial = async (target: "github" | "x") => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.openSocial(target));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.completeOnboarding(selectedLanguage));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className="welcome"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <header className="welcome-top draggable">
        <div className="welcome-brand no-drag">
          <BrandMark small />
          <span>{localized.product}</span>
        </div>
        <span className="welcome-version no-drag">v{snapshot.version}</span>
      </header>

      <AnimatePresence mode="wait">
        <motion.section
          animate={{ opacity: 1, y: 0 }}
          className="welcome-stage"
          exit={{ opacity: 0, y: -8 }}
          initial={{ opacity: 0, y: 8 }}
          key={stage}
          transition={PANEL_TRANSITION}
        >
          <span className="welcome-kicker">{isLanguage ? "01" : "02"}</span>
          <h1>{isLanguage ? localized.chooseLanguage : localized.supportTitle}</h1>
          <p>{isLanguage ? localized.chooseLanguageHint : localized.supportBody}</p>

          {isLanguage ? (
            <div className="welcome-options" role="radiogroup" aria-label={localized.chooseLanguage}>
              <WelcomeOption
                active={selectedLanguage === "en"}
                detail="English"
                label="English"
                marker="EN"
                onClick={() => setSelectedLanguage("en")}
              />
              <WelcomeOption
                active={selectedLanguage === "zh-CN"}
                detail="简体中文"
                label="简体中文"
                marker="简"
                onClick={() => setSelectedLanguage("zh-CN")}
              />
            </div>
          ) : (
            <div className="welcome-options">
              <WelcomeAction
                complete={snapshot.state.githubOpened}
                disabled={busy}
                icon="github"
                label={snapshot.state.githubOpened ? localized.starred : localized.star}
                onClick={() => openSocial("github")}
              />
              <WelcomeAction
                complete={snapshot.state.xOpened}
                disabled={busy}
                icon="x"
                label={snapshot.state.xOpened ? localized.followed : localized.follow}
                onClick={() => openSocial("x")}
              />
            </div>
          )}
        </motion.section>
      </AnimatePresence>

      <footer className="welcome-footer">
        <div>
          {!isLanguage ? (
            <button className="text-button" onClick={() => setStage("language")} type="button">
              {localized.previous}
            </button>
          ) : null}
        </div>
        <div className="welcome-progress" aria-label={`${isLanguage ? 1 : 2} / 2`}>
          <span className={!isLanguage ? "is-complete" : "is-active"} />
          <span className={!isLanguage ? "is-active" : ""} />
        </div>
        <PrimaryButton
          disabled={busy || (!isLanguage && (!snapshot.state.githubOpened || !snapshot.state.xOpened))}
          onClick={isLanguage ? chooseLanguage : finish}
        >
          {isLanguage ? localized.continue : localized.finishWelcome}
        </PrimaryButton>
      </footer>
    </motion.main>
  );
}

function LauncherShell({
  browser,
  copy,
  language,
  logs,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  browser: BrowserState | null;
  copy: Copy;
  language: Language;
  logs: LogRecord[];
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [surface, setSurface] = useState<Surface>(
    snapshot.state.coreSetupComplete && snapshot.state.codexCatalogVerified ? "browser" : "setup",
  );
  const compactAtMount = useRef(window.matchMedia(COMPACT_SIDEBAR_QUERY).matches).current;
  const [sidebarOpen, setSidebarOpen] = useState(!compactAtMount);
  const [compactSidebar, setCompactSidebar] = useState(compactAtMount);
  const [browserSlot, setBrowserSlot] = useState<HTMLDivElement | null>(null);
  const [sessionReminderBusy, setSessionReminderBusy] = useState(false);
  const [sessionReminderDue, setSessionReminderDue] = useState(false);
  const browserSlotRef = useCallback((node: HTMLDivElement | null) => setBrowserSlot(node), []);
  const browserSurfaceActive = surface === "browser" && !(compactSidebar && sidebarOpen);
  const needsBrowser = browser?.authenticated !== true;
  const needsSetup = !needsBrowser
    && (snapshot.state.coreSetupComplete !== true || snapshot.state.codexCatalogVerified !== true);
  const mcpOptional = snapshot.state.codexCatalogVerified === true && snapshot.state.mcpSetupComplete !== true;
  const updateVisible = ["available", "downloading", "installing"].includes(snapshot.update.status);
  const updateBusy = snapshot.update.status === "downloading" || snapshot.update.status === "installing";
  const updateVersion = "version" in snapshot.update ? snapshot.update.version : null;

  useLayoutEffect(() => {
    let cancelled = false;
    let animationFrame = 0;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (!browserSlot) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rect = browserSlot.getBoundingClientRect();
        void api!.setBrowserBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch((cause) => setError(messageOf(cause)));
      });
    };

    void api!.setBrowserSurfaceActive(browserSurfaceActive).then(() => {
      if (cancelled || !browserSurfaceActive || !browserSlot) return;
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(browserSlot);
      window.addEventListener("resize", measure);
    }).catch((cause) => setError(messageOf(cause)));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [browserSlot, browserSurfaceActive, setError]);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const apply = () => {
      setCompactSidebar(media.matches);
      setSidebarOpen(!media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const reminderAt = snapshot.state.sessionRefreshReminderAt;
    const reminderTime = reminderAt === null ? Number.NaN : Date.parse(reminderAt);
    if (browser?.authenticated !== true || !Number.isFinite(reminderTime)) {
      setSessionReminderDue(false);
      return;
    }
    const delay = reminderTime - Date.now();
    if (delay <= 0) {
      setSessionReminderDue(true);
      return;
    }
    setSessionReminderDue(false);
    const timer = window.setTimeout(() => setSessionReminderDue(true), delay);
    return () => window.clearTimeout(timer);
  }, [browser?.authenticated, snapshot.state.sessionRefreshReminderAt]);

  const activateBrowser = useCallback(async (show = false) => {
    setSurface("browser");
    await api!.setBrowserSurfaceActive(true);
    if (show) await api!.showBrowser();
  }, []);

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    if (compactSidebar && next && surface === "browser") {
      void api!.setBrowserSurfaceActive(false)
        .then(() => setSidebarOpen(true))
        .catch((cause) => setError(messageOf(cause)));
      return;
    }
    setSidebarOpen(next);
  };

  const navigateSurface = (next: Surface) => {
    setSurface(next);
    if (compactSidebar) setSidebarOpen(false);
  };

  const installUpdate = async () => {
    setError(null);
    try {
      await api!.installUpdate();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const dismissSessionReminder = async () => {
    if (sessionReminderBusy) return;
    setSessionReminderBusy(true);
    setError(null);
    try {
      updateState(await api!.dismissSessionReminder());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSessionReminderBusy(false);
    }
  };

  const logoutChatGpt = async () => {
    if (sessionReminderBusy) return;
    setSessionReminderBusy(true);
    setError(null);
    try {
      const result = await api!.logoutChatGpt();
      updateState(result.state);
      navigateSurface("browser");
      await api!.setBrowserSurfaceActive(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSessionReminderBusy(false);
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className={`app-shell${compactSidebar ? " is-compact" : ""}${sidebarOpen ? " is-sidebar-open" : ""}`}
      initial={{ opacity: 0 }}
    >
      <TitleBar
        copy={copy}
        sidebarOpen={sidebarOpen}
        toggleSidebar={toggleSidebar}
      />

      {compactSidebar && sidebarOpen ? (
        <button
          aria-label={copy.hideSidebar}
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}

      <motion.aside
        animate={{ width: sidebarOpen ? "var(--sidebar-width)" : 0 }}
        className="app-sidebar"
        initial={false}
        transition={{ type: "spring", duration: 0.5, bounce: 0.08 }}
      >
        <div className="sidebar-clip">
          <div className="sidebar-content">
            <div className="sidebar-brand-row">
              <div className="sidebar-brand-identity">
                <BrandMark small />
                <strong>{copy.product}</strong>
              </div>
              <div className="sidebar-brand-actions">
                <IconButton
                  icon="github"
                  label="GitHub"
                  onClick={() => void api!.openExternal(snapshot.urls.github).catch((cause) => setError(messageOf(cause)))}
                />
                <IconButton
                  icon="x"
                  label="X"
                  onClick={() => void api!.openExternal(snapshot.urls.x).catch((cause) => setError(messageOf(cause)))}
                />
              </div>
            </div>

            <nav className="sidebar-nav" aria-label={copy.workspace}>
              <SidebarGroup label={copy.workspace}>
                <SidebarItem
                  active={surface === "browser"}
                  badge={needsBrowser
                    ? <ActionDot pulse tone="required" />
                    : browser?.status === "error"
                      ? <ActionDot tone="error" />
                      : null}
                  icon="browser"
                  label={copy.browser}
                  onClick={() => navigateSurface("browser")}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.configuration}>
                <SidebarItem
                  active={surface === "setup"}
                  badge={needsSetup ? <ActionDot pulse tone="required" /> : null}
                  icon="setup"
                  label={copy.setup}
                  onClick={() => navigateSurface("setup")}
                />
                <SidebarItem
                  active={surface === "mcp"}
                  badge={mcpOptional ? <ActionDot tone="optional" /> : null}
                  icon="mcp"
                  label="MCP"
                  onClick={() => navigateSurface("mcp")}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.runtime}>
                <SidebarItem active={surface === "activity"} icon="activity" label={copy.activity} onClick={() => navigateSurface("activity")} />
              </SidebarGroup>
            </nav>

            <div className="sidebar-footer">
              {updateVisible ? (
                <SidebarItem
                  active={false}
                  disabled={updateBusy || operation?.status === "running" || browser?.status === "running"}
                  icon="update"
                  label={updateBusy ? copy.updating : `${copy.updateAvailable} v${updateVersion}`}
                  onClick={() => void installUpdate()}
                  tone="update"
                />
              ) : null}
              <SidebarItem
                active={surface === "settings"}
                badge={snapshot.state.coreSetupComplete
                  ? <ActionDot tone={snapshot.state.bridgeEnabled ? "success" : "error"} />
                  : null}
                icon="settings"
                label={copy.settings}
                onClick={() => navigateSurface("settings")}
              />
            </div>
          </div>
        </div>
      </motion.aside>

      <section className="workspace">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            animate={{ opacity: 1 }}
            className="surface-transition"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key={surface}
            transition={{ duration: 0.16 }}
          >
            {surface === "browser" ? (
              <BrowserSurface
                browser={browser}
                browserSlotRef={browserSlotRef}
                copy={copy}
                setError={setError}
              />
            ) : null}
            {surface === "setup" ? (
              <SetupSurface
                activateBrowser={activateBrowser}
                browser={browser}
                copy={copy}
                operation={operation}
                setError={setError}
                showMcp={() => setSurface("mcp")}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "mcp" ? (
              <McpSurface
                copy={copy}
                onDone={() => setSurface("browser")}
                operation={operation}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "activity" ? <ActivitySurface copy={copy} logs={logs} setError={setError} /> : null}
            {surface === "settings" ? (
              <SettingsSurface
                copy={copy}
                language={language}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {sessionReminderDue ? (
          <SessionRefreshReminder
            busy={sessionReminderBusy}
            copy={copy}
            onDismiss={() => void dismissSessionReminder()}
            onLogout={() => void logoutChatGpt()}
          />
        ) : null}
      </AnimatePresence>
    </motion.main>
  );
}

function TitleBar({
  copy,
  sidebarOpen,
  toggleSidebar,
}: {
  copy: Copy;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}) {
  return (
    <header className="app-titlebar draggable">
      <div className="titlebar-left no-drag">
        <IconButton
          icon="sidebar"
          label={sidebarOpen ? copy.hideSidebar : copy.showSidebar}
          onClick={toggleSidebar}
        />
      </div>
    </header>
  );
}

function SidebarGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="sidebar-group">
      <h2>{label}</h2>
      <div>{children}</div>
    </section>
  );
}

function SidebarItem({
  active,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  tone,
}: {
  active: boolean;
  badge?: ReactNode;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: "update";
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`sidebar-item${active ? " is-active" : ""}${tone === "update" ? " is-update" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon name={icon} />
      <span>{label}</span>
      {badge ? <i className="sidebar-item-badge">{badge}</i> : null}
    </button>
  );
}

function BrowserSurface({
  browser,
  browserSlotRef,
  copy,
  setError,
}: {
  browser: BrowserState | null;
  browserSlotRef: (node: HTMLDivElement | null) => void;
  copy: Copy;
  setError: (error: string | null) => void;
}) {
  const visible = browser?.visible === true;
  const navigationLocked = browser?.status === "running" || browser?.status === "testing";
  const navigate = async (action: "back" | "forward" | "reload") => {
    try {
      await api!.navigateBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const zoom = async (action: "in" | "out" | "reset") => {
    try {
      await api!.zoomBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const toggle = async () => {
    try {
      if (visible) await api!.hideBrowser();
      else await api!.showBrowser();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const selectTab = async (tabId: string) => {
    try {
      await api!.selectBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const closeTab = async (tabId: string) => {
    try {
      await api!.closeBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <section className="browser-surface">
      <div className="browser-tab-strip" title={copy.browserTabLimit}>
        {(browser?.tabs ?? []).map((tab) => (
          <div
            className={`browser-tab${tab.active ? " is-active" : ""}`}
            key={tab.id}
            onClick={() => void selectTab(tab.id)}
            role="tab"
            aria-selected={tab.active}
          >
            <BrandMark small />
            <span title={tab.traceId ? `${tab.title} · ${tab.traceId}` : tab.title}>
              {browserTabTitleFromTitle(tab.title, copy)}
            </span>
            {tab.loading ? <i className="tab-spinner" /> : <StateDot state={browserTabTone(tab.status)} />}
            {tab.closable ? (
              <button
                aria-label={copy.hideTab}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
                title={copy.hideTab}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
        ))}
        <div className="browser-tab-drag draggable" />
      </div>
      <div className="browser-toolbar">
        <div className="browser-history">
          <IconButton
            disabled={navigationLocked || !browser?.canGoBack}
            icon="back"
            label={copy.back}
            onClick={() => void navigate("back")}
          />
          <IconButton
            disabled={navigationLocked || !browser?.canGoForward}
            icon="forward"
            label={copy.forward}
            onClick={() => void navigate("forward")}
          />
          <IconButton disabled={navigationLocked || !visible} icon="reload" label={copy.reload} onClick={() => void navigate("reload")} />
        </div>
        <div className="browser-address" title={browser?.url || copy.browserAddress}>
          <Icon name="globe" />
          <span>{formatBrowserAddress(browser?.url, copy)}</span>
        </div>
        <div className="browser-zoom-controls">
          <IconButton icon="minus" label={copy.zoomOut} onClick={() => void zoom("out")} />
          <button
            aria-label={copy.zoomReset}
            className="browser-zoom-reset"
            onClick={() => void zoom("reset")}
            title={copy.zoomReset}
            type="button"
          >
            {Math.round((browser?.zoomFactor ?? 1) * 100)}%
          </button>
          <IconButton icon="plus" label={copy.zoomIn} onClick={() => void zoom("in")} />
        </div>
        <button className="toolbar-text-button" onClick={() => void toggle()} type="button">
          {visible ? copy.hideBrowser : copy.openChatgpt}
        </button>
        {browser?.loading ? <i className="browser-loading-line" /> : null}
      </div>
      <div className="browser-viewport" ref={browserSlotRef}>
        {!visible ? (
          <div className="browser-empty">
            <BrandMark />
            <h1>{browser?.authenticated ? copy.noActiveTask : copy.stepAccount}</h1>
            <p>{browser?.authenticated ? copy.noActiveTaskBody : copy.stepAccountBody}</p>
            <PrimaryButton onClick={() => void toggle()}>
              {browser?.authenticated ? copy.openChatgpt : copy.signIn}
            </PrimaryButton>
          </div>
        ) : (
          <div className="browser-underlay" aria-hidden="true">
            <span>{copy.loading}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function SetupSurface({
  activateBrowser,
  browser,
  copy,
  operation,
  setError,
  showMcp,
  snapshot,
  updateState,
}: {
  activateBrowser: (show?: boolean) => Promise<void>;
  browser: BrowserState | null;
  copy: Copy;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  showMcp: () => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const busy = localBusy
    || operation?.status === "running"
    || browser?.status === "loading"
    || browser?.status === "testing"
    || browser?.status === "running";
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };

  const openLogin = () => run(async () => {
    await activateBrowser();
    await api!.openLogin();
  });
  const smoke = () => run(async () => {
    await activateBrowser();
    await api!.smokeTest();
    updateState((await api!.snapshot()).state);
  });
  const install = () => run(async () => {
    await api!.setupCore();
    updateState((await api!.snapshot()).state);
  });

  return (
    <ContentSurface
      eyebrow={copy.required}
      subtitle={copy.setupSubtitle}
      title={copy.setupTitle}
    >
      <SectionHeading label={copy.coreSetup} />
      <div className="setup-list">
        <SetupRow
          action={browser?.authenticated
            ? copy.signedIn
            : browser?.status === "loading" ? copy.checkingSignIn : copy.signIn}
          complete={browser?.authenticated === true}
          description={copy.stepAccountBody}
          disabled={busy}
          index={1}
          onAction={openLogin}
          title={copy.stepAccount}
        />
        <SetupRow
          action={snapshot.smokePassed ? copy.smokePassed : copy.runSmoke}
          complete={snapshot.smokePassed}
          description={copy.stepSmokeBody}
          disabled={busy || !browser?.authenticated}
          index={2}
          onAction={smoke}
          title={copy.stepSmoke}
        />
        <SetupRow
          action={snapshot.state.coreSetupComplete ? copy.reinstall : copy.install}
          complete={snapshot.state.codexCatalogVerified === true}
          description={copy.stepInstallBody}
          disabled={busy
            || (!snapshot.smokePassed && snapshot.state.coreSetupComplete !== true)}
          index={3}
          onAction={install}
          repeatable
          title={copy.stepInstall}
        />
      </div>

      {snapshot.state.codexRestartRequired ? (
        <NoticeRow icon="alert" tone="warning">
          {copy.restartCodex}
        </NoticeRow>
      ) : null}

      <SectionHeading label="MCP" meta={copy.optional} spaced />
      <button className="next-surface-row" disabled={!snapshot.state.codexCatalogVerified} onClick={showMcp} type="button">
        <Icon name="mcp" />
        <span>
          <strong>{copy.mcpTitle}</strong>
          <small>{copy.mcpBody}</small>
        </span>
        <em>{snapshot.state.mcpSetupComplete ? copy.mcpReady : copy.configureMcp}</em>
        <Icon name="chevron" />
      </button>
    </ContentSurface>
  );
}

function McpSurface({
  copy,
  onDone,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  onDone: () => void;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [step, setStep] = useState(Math.min(2, Math.max(0, snapshot.state.mcpGuideStep || 0)));
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [credentialsConfigured, setCredentialsConfigured] = useState(snapshot.mcpCredentialsConfigured);
  const [replacingCredentials, setReplacingCredentials] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const busy = localBusy || operation?.status === "running";
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const steps = useMemo(() => [
    { title: copy.mcpStepOne, body: copy.mcpStepOneBody },
    { title: copy.mcpStepTwo, body: copy.mcpStepTwoBody },
    { title: copy.mcpStepThree, body: copy.mcpStepThreeBody },
  ], [copy]);

  const move = async (next: number) => {
    setStep(next);
    updateState(await api!.setMcpStep(next));
  };
  const safeMove = async (next: number) => {
    if (busy) return;
    setError(null);
    try {
      await move(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const openExternal = async (url: string) => {
    setError(null);
    try {
      await api!.openExternal(url);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const install = async () => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    try {
      await api!.setupMcp({
        ...(credentialsConfigured && !replacingCredentials
          ? { replace: false }
          : { tunnelId, runtimeKey, replace: true }),
      });
      setRuntimeKey("");
      setTunnelId("");
      setCredentialsConfigured(true);
      setReplacingCredentials(false);
      updateState((await api!.snapshot()).state);
      await move(2);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };
  const verify = async () => {
    if (busy) return;
    setLocalBusy(true);
    setError(null);
    setDoctor(null);
    try {
      setDoctor(await api!.verifyMcp());
      updateState((await api!.snapshot()).state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <ContentSurface fit subtitle={copy.mcpSubtitle} title="MCP">
      {!snapshot.state.codexCatalogVerified ? (
        <NoticeRow icon="setup" tone="warning">{copy.mcpCatalogRequired}</NoticeRow>
      ) : null}

      <div className="wizard-stepper" aria-label={`${step + 1} / 3`}>
        {steps.map((item, index) => (
          <button
            className={`${index === step ? "is-active" : ""}${index < step ? " is-complete" : ""}`}
            disabled={busy || index > step}
            key={item.title}
            onClick={() => void safeMove(index)}
            type="button"
          >
            <span>{index < step ? <Icon name="check" /> : index + 1}</span>
            <em>{item.title}</em>
          </button>
        ))}
      </div>

      <div className="mcp-stage">
        <div className="guide-media">
          <img alt={`${copy.guideVideo}: ${steps[step]!.title}`} src={MCP_GUIDE_MEDIA[step]} />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            animate={{ opacity: 1, x: 0 }}
            className="wizard-content"
            exit={{ opacity: 0, x: -8 }}
            initial={{ opacity: 0, x: 8 }}
            key={step}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <header>
              <span>0{step + 1}</span>
              <div>
                <h2>{steps[step]!.title}</h2>
                <p>{steps[step]!.body}</p>
              </div>
            </header>

            {step === 0 ? (
              <div className="inline-actions">
                <SecondaryButton icon="external" onClick={() => void openExternal(snapshot.urls.tunnels)}>
                  {copy.openTunnels}
                </SecondaryButton>
                <SecondaryButton icon="external" onClick={() => void openExternal(snapshot.urls.keys)}>
                  {copy.openKeys}
                </SecondaryButton>
              </div>
            ) : null}
            {step === 1 ? (
              credentialsConfigured && !replacingCredentials ? (
                <div className="saved-credentials">
                  <NoticeRow icon="check" tone="success">
                    <span>
                      <strong>{copy.credentialsConfigured}</strong>
                      <small>{copy.credentialsConfiguredBody}</small>
                    </span>
                  </NoticeRow>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setReplacingCredentials(true)}
                    type="button"
                  >
                    {copy.replaceCredentials}
                  </button>
                </div>
              ) : (
                <div className="field-list">
                  <FieldRow label={copy.tunnelId}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setTunnelId(event.target.value)}
                      placeholder="tunnel_…"
                      spellCheck={false}
                      value={tunnelId}
                    />
                  </FieldRow>
                  <FieldRow label={copy.runtimeKey}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setRuntimeKey(event.target.value)}
                      placeholder="sk-…"
                      spellCheck={false}
                      type="password"
                      value={runtimeKey}
                    />
                  </FieldRow>
                  {credentialsConfigured ? (
                    <button
                      className="text-button keep-credentials"
                      disabled={busy}
                      onClick={() => {
                        setTunnelId("");
                        setRuntimeKey("");
                        setReplacingCredentials(false);
                      }}
                      type="button"
                    >
                      {copy.keepCredentials}
                    </button>
                  ) : null}
                </div>
              )
            ) : null}
            {step === 1 ? (
              <p className="mcp-step-two-hint">
                {snapshot.state.codexCatalogVerified ? copy.mcpStepTwoHint : copy.mcpCatalogRequired}
              </p>
            ) : null}
            {step === 2 ? (
              <div className="connector-actions">
                <NoticeRow icon="alert" tone="warning">{copy.connectorMigrationNotice}</NoticeRow>
                <div className="connector-name">
                  <span>{copy.connectorName}</span>
                  <code>{snapshot.connectorName}</code>
                </div>
                <div className="inline-actions">
                  <SecondaryButton
                    icon="external"
                    onClick={() => void (async () => {
                      setError(null);
                      try {
                        await api!.openExternal(snapshot.urls.connectors);
                      } catch (cause) {
                        setError(messageOf(cause));
                      }
                    })()}
                  >
                    {copy.openConnectors}
                  </SecondaryButton>
                </div>
                {doctor ? <DoctorSummary copy={copy} report={doctor} /> : null}
              </div>
            ) : null}
          </motion.section>
        </AnimatePresence>
      </div>

      <div className="wizard-footer">
        <button className="text-button" disabled={step === 0 || busy} onClick={() => void safeMove(step - 1)} type="button">
          {copy.previous}
        </button>
        {step === 0 ? <PrimaryButton disabled={busy} onClick={() => void safeMove(1)}>{copy.next}</PrimaryButton> : null}
        {step === 1 ? (
          <PrimaryButton
            disabled={
              busy
              || !snapshot.state.codexCatalogVerified
              || ((!credentialsConfigured || replacingCredentials) && (!tunnelId || !runtimeKey))
            }
            onClick={() => void install()}
          >
            {busy ? copy.running : credentialsConfigured && !replacingCredentials ? copy.reconnect : copy.connect}
          </PrimaryButton>
        ) : null}
        {step === 2 ? (
          <PrimaryButton
            disabled={busy}
            onClick={() => void (doctor?.ok ? onDone() : verify())}
          >
            {busy
              ? operation?.name === "mcp-verification" && operation.status === "running"
                ? operation.message
                : copy.running
              : doctor?.ok ? copy.done : copy.verifyRuntime}
          </PrimaryButton>
        ) : null}
      </div>
    </ContentSurface>
  );
}

function ActivitySurface({
  copy,
  logs,
  setError,
}: {
  copy: Copy;
  logs: LogRecord[];
  setError: (error: string | null) => void;
}) {
  return (
    <ContentSurface subtitle={copy.activitySubtitle} title={copy.activityTitle}>
      <div className="section-heading activity-heading">
        <span>{copy.recentActivity}</span>
        <SecondaryButton
          icon="external"
          onClick={() => void api!.openLogs().catch((cause) => setError(messageOf(cause)))}
        >
          {copy.openLogFolder}
        </SecondaryButton>
      </div>
      <div className="activity-table">
        {logs.length === 0 ? (
          <div className="surface-empty">
            <Icon name="logs" />
            <span>{copy.noLogs}</span>
          </div>
        ) : null}
        {[...logs].reverse().map((record, index) => (
          <div className="activity-row" key={`${record.at}-${record.event}-${index}`}>
            <StateDot state={record.level === "error" ? "error" : record.level === "warning" ? "busy" : "ready"} />
            <div>
              <strong>{humanEvent(record.event)}</strong>
              <span>{logDetail(record.detail)}</span>
            </div>
            <time>{formatTime(record.at)}</time>
          </div>
        ))}
      </div>
    </ContentSurface>
  );
}

function SettingsSurface({
  copy,
  language,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnsCancelled, setTurnsCancelled] = useState(false);
  const [integrationRemoved, setIntegrationRemoved] = useState(false);

  const updateLanguage = async (next: Language) => {
    try {
      updateState(await api!.setLanguage(next));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const runDoctor = async () => {
    setBusy(true);
    try {
      setDoctor(await api!.doctor());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancelTurns = async () => {
    setBusy(true);
    setError(null);
    try {
      await api!.cancelTurns();
      setTurnsCancelled(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setBridgeEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setBridgeEnabled(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const uninstallIntegration = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api!.uninstallIntegration();
      if (!result.cancelled) {
        updateState(result.state);
        setIntegrationRemoved(true);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface narrow title={copy.settingsTitle}>
      <SectionHeading label={copy.general} />
      <div className="settings-list">
        <SettingRow body={copy.launchAtLoginBody} label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.bridgeRouteBody} label={copy.bridgeRoute}>
          <Switch
            checked={snapshot.state.bridgeEnabled}
            disabled={busy || snapshot.state.coreSetupComplete !== true}
            onChange={(checked) => void setBridgeEnabled(checked)}
          />
        </SettingRow>
        <SettingRow body={copy.keepRunningOnCloseBody} label={copy.keepRunningOnClose}>
          <Switch
            checked={snapshot.state.keepRunningOnClose}
            onChange={(checked) => void api!.setPreference("keepRunningOnClose", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.showDuringTurnsBody} label={copy.showDuringTurns}>
          <Switch
            checked={snapshot.state.showBrowserDuringTurns}
            onChange={(checked) => void api!.setPreference("showBrowserDuringTurns", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.chooseLanguageHint} label={copy.language}>
          <LanguageMenu language={language} onChange={(next) => void updateLanguage(next)} />
        </SettingRow>
      </div>

      <SectionHeading label={copy.diagnostics} spaced />
      <button className="diagnostic-row" disabled={busy} onClick={() => void runDoctor()} type="button">
        <Icon name="activity" />
        <span>
          <strong>{copy.runDoctor}</strong>
          <small>{doctor ? (doctor.ok ? copy.healthy : copy.needsAttention) : copy.status}</small>
        </span>
        <Icon name="chevron" />
      </button>
      <button className="diagnostic-row" disabled={busy} onClick={() => void cancelTurns()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.cancelTurns}</strong>
          <small>{turnsCancelled ? copy.turnsCancelled : copy.cancelTurnsBody}</small>
        </span>
        <Icon name="chevron" />
      </button>
      <button className="diagnostic-row" disabled={busy} onClick={() => void uninstallIntegration()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.uninstallIntegration}</strong>
          <small>{integrationRemoved ? copy.integrationRemoved : copy.uninstallIntegrationBody}</small>
        </span>
        <Icon name="chevron" />
      </button>
      {doctor ? <DoctorSummary copy={copy} report={doctor} /> : null}

      <div className="about-row">
        <BrandMark small />
        <span>
          <strong>{copy.product}</strong>
          <small>{platformLabel(snapshot.platform)} · v{snapshot.version}</small>
        </span>
      </div>
    </ContentSurface>
  );
}

function ContentSurface({
  children,
  eyebrow,
  fit = false,
  narrow = false,
  subtitle,
  title,
}: {
  children: ReactNode;
  eyebrow?: string;
  fit?: boolean;
  narrow?: boolean;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="content-surface">
      <div className={`content-scroll${narrow ? " is-narrow" : ""}${fit ? " is-fit" : ""}`}>
        <header className="surface-header">
          {eyebrow ? <span>{eyebrow}</span> : null}
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}

function SetupRow({
  action,
  complete,
  description,
  disabled,
  index,
  onAction,
  repeatable = false,
  title,
}: {
  action: string;
  complete: boolean;
  description: string;
  disabled: boolean;
  index: number;
  onAction: () => void;
  repeatable?: boolean;
  title: string;
}) {
  return (
    <div className={`setup-row${complete ? " is-complete" : ""}`}>
      <span className="setup-index">{complete ? <Icon name="check" /> : index}</span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <SecondaryButton disabled={disabled || (complete && !repeatable)} onClick={onAction}>
        {action}
      </SecondaryButton>
    </div>
  );
}

function SectionHeading({ label, meta, spaced = false }: { label: string; meta?: string; spaced?: boolean }) {
  return (
    <div className={`section-heading${spaced ? " is-spaced" : ""}`}>
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function NoticeRow({
  children,
  icon,
  tone,
}: {
  children: ReactNode;
  icon: IconName;
  tone: "warning" | "success";
}) {
  return (
    <div className={`notice-row tone-${tone}`}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

function SettingRow({ body, children, label }: { body: string; children: ReactNode; label: string }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

function FieldRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DoctorSummary({ copy, report }: { copy: Copy; report: DoctorReport }) {
  const visibleChecks = report.ok
    ? report.checks.slice(-6)
    : report.checks.filter((check) => check.status !== "ok");
  return (
    <div className={`doctor-summary${report.ok ? " is-healthy" : ""}`}>
      <header>
        <Icon name={report.ok ? "check" : "activity"} />
        <strong>{report.ok ? copy.healthy : copy.needsAttention}</strong>
      </header>
      <div>
        {visibleChecks.map((check) => (
          <p key={check.id}>
            <StateDot state={check.status === "ok" ? "ready" : check.status === "warning" ? "busy" : "error"} />
            <span>{check.message}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function WelcomeOption({
  active,
  detail,
  label,
  marker,
  onClick,
}: {
  active: boolean;
  detail: string;
  label: string;
  marker: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={`welcome-option${active ? " is-active" : ""}`}
      onClick={onClick}
      role="radio"
      type="button"
    >
      <span>{marker}</span>
      <strong>{label}</strong>
      <small>{detail}</small>
      {active ? <Icon name="check" /> : null}
    </button>
  );
}

function WelcomeAction({
  complete,
  disabled,
  icon,
  label,
  onClick,
}: {
  complete: boolean;
  disabled?: boolean;
  icon: "github" | "x";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`welcome-option is-social${complete ? " is-complete" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span><Icon name={icon} /></span>
      <strong>{label}</strong>
      <Icon name={complete ? "check" : "external"} />
    </button>
  );
}

function PrimaryButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="button-primary" disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  disabled = false,
  icon,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  icon?: IconName;
  onClick: () => void;
}) {
  return (
    <button className="button-secondary" disabled={disabled} onClick={onClick} type="button">
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  disabled = false,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="icon-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  );
}

function Switch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

function LanguageMenu({ language, onChange }: { language: Language; onChange: (language: Language) => void }) {
  const [open, setOpen] = useState(false);
  const options: Array<{ label: string; value: Language }> = [
    { label: "English", value: "en" },
    { label: "简体中文", value: "zh-CN" },
  ];
  const selected = options.find((option) => option.value === language) ?? options[0];

  return (
    <div
      className={`language-menu${open ? " is-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="language-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{selected.label}</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <>
          <button
            aria-label="Close language menu"
            className="language-menu-scrim"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div aria-label="Language" className="language-menu-panel" role="listbox">
            {options.map((option) => (
              <button
                aria-selected={option.value === language}
                className={option.value === language ? "is-selected" : ""}
                key={option.value}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== language) onChange(option.value);
                }}
                role="option"
                type="button"
              >
                <span>{option.label}</span>
                {option.value === language ? <Icon name="check" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function StateDot({ state }: { state: "idle" | "ready" | "busy" | "error" }) {
  return <i aria-hidden="true" className={`state-dot is-${state}`} />;
}

function ActionDot({ pulse = false, tone }: { pulse?: boolean; tone: "required" | "optional" | "success" | "error" }) {
  return <i aria-hidden="true" className={`action-dot is-${tone}${pulse ? " is-pulse" : ""}`} />;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark${small ? " is-small" : ""}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function ErrorToast({ copy, message, onDismiss }: { copy: Copy; message: string; onDismiss: () => void }) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="error-toast"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      transition={PANEL_TRANSITION}
    >
      <StateDot state="error" />
      <span>
        <strong>{copy.error}</strong>
        <p>{message}</p>
      </span>
      <button onClick={onDismiss} type="button">{copy.dismiss}</button>
    </motion.div>
  );
}

function SessionRefreshReminder({
  busy,
  copy,
  onDismiss,
  onLogout,
}: {
  busy: boolean;
  copy: Copy;
  onDismiss: () => void;
  onLogout: () => void;
}) {
  return (
    <motion.aside
      animate={{ opacity: 1, y: 0 }}
      aria-live="polite"
      className="session-refresh-reminder"
      exit={{ opacity: 0, y: -8 }}
      initial={{ opacity: 0, y: -8 }}
      transition={PANEL_TRANSITION}
    >
      <span className="session-refresh-reminder-icon"><Icon name="alert" /></span>
      <div className="session-refresh-reminder-copy">
        <strong>{copy.sessionReminderTitle}</strong>
        <p>{copy.sessionReminderBody}</p>
      </div>
      <div className="session-refresh-reminder-actions">
        <button className="text-button" disabled={busy} onClick={onDismiss} type="button">
          {copy.dismiss}
        </button>
        <button className="button-primary" disabled={busy} onClick={onLogout} type="button">
          {copy.logOut}
        </button>
      </div>
    </motion.aside>
  );
}

function LaunchLoading() {
  return (
    <main className="launch-loading">
      <BrandMark />
      <span />
    </main>
  );
}

function FatalMessage({ message }: { message: string }) {
  return (
    <main className="fatal-message">
      <BrandMark />
      <h1>Codex Web GPT</h1>
      <p>{message}</p>
    </main>
  );
}

function browserTabTitleFromTitle(value: string | undefined, copy: Copy): string {
  const title = value?.trim();
  if (!title || title === "about:blank" || title.includes("codex-web-gpt-browser-host")) return copy.temporaryChat;
  return title.replace(/\s*[|–-]\s*ChatGPT\s*$/i, "") || copy.temporaryChat;
}

function browserTabTone(status: BrowserState["tabs"][number]["status"]): "idle" | "ready" | "busy" | "error" {
  if (status === "error" || status === "aborted") return "error";
  if (status === "loading" || status === "running" || status === "testing") return "busy";
  if (status === "ready") return "ready";
  return "idle";
}

function formatBrowserAddress(url: string | undefined, copy: Copy): string {
  if (!url || url.startsWith("about:blank")) return copy.browserAddress;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "chatgpt.com" && parsed.searchParams.get("temporary-chat") === "true") {
      return `chatgpt.com  /  ${copy.temporaryChat}`;
    }
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return copy.browserAddress;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function platformLabel(value: string): string {
  return value === "darwin" ? "macOS" : value === "win32" ? "Windows" : value === "linux" ? "Linux" : value;
}

function humanEvent(value: string): string {
  return value.split(".").map((part) => part.replaceAll("_", " ")).join(" · ");
}

function logDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
