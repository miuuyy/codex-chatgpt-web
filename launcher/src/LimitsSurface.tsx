import { useEffect, useRef } from "react";
import { Icon } from "./icons";
import { limitsCopyFor, type LimitsCopy } from "./limits-copy";
import { localizeMessage } from "./runtime-copy";
import type { LimitsApi, LimitsWindow } from "./limits-types";
import { limitNeedsAttention, type LimitsTracker } from "./useLimits";
import type { Language } from "./types";
import "./limits.css";
import policy from "../electron/limits-policy.json";

export const LIMITS_REFERENCE_URL = policy.sourceUrl;
const DAY_MS = 24 * 60 * 60 * 1000;

export function LimitsSurface({
  api,
  tracker,
  language,
  manualMode,
  runtimeBusy,
  setError,
}: {
  api: LimitsApi;
  tracker: LimitsTracker;
  language: Language;
  manualMode: boolean;
  runtimeBusy: boolean;
  setError: (error: string | null) => void;
}) {
  const copy = limitsCopyFor(language);
  const { snapshot, reading, settingUp, readError, setupError } = tracker;
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const zeroRisk = manualMode || snapshot?.disabledReason === "zero-risk";
  const unsupported = snapshot?.plan === "unsupported";
  const supported = snapshot?.plan === "pro_100" || snapshot?.plan === "pro_200";
  const tracking = snapshot?.enabled === true && supported && !zeroRisk;
  const setupDisabled = zeroRisk || runtimeBusy || settingUp || !snapshot;
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const date = (value: number | null) => value === null ? copy.unknown : new Intl.DateTimeFormat(language, {
    dateStyle: "medium", timeStyle: "short",
  }).format(value);

  const setup = async () => {
    if (setupDisabled) return;
    setError(null);
    try {
      const next = await tracker.setup();
      if (mounted.current && next?.error) setError(next.error);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause) || copy.actionError);
    }
  };

  const openReference = async () => {
    try {
      const opened = await api.openExternal(LIMITS_REFERENCE_URL);
      if (!opened && mounted.current) setError(copy.sourceError);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause) || copy.sourceError);
    }
  };

  const planLabel = snapshot?.plan === "pro_200" ? "Pro $200" : snapshot?.plan === "pro_100" ? "Pro $100" : null;
  const stateLabel = zeroRisk ? copy.zeroRisk : unsupported ? copy.proOnly : tracking ? copy.active
    : supported ? copy.paused : copy.notConfigured;
  const error = setupError || snapshot?.error;

  return (
    <section aria-labelledby="limits-title" className="content-surface limits-surface">
      <div className="content-scroll limits-scroll">
        <header className="surface-header limits-page-header">
          <div>
            <h1 id="limits-title">{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
          <button
            aria-label={copy.refresh}
            className="button-secondary limits-refresh"
            disabled={reading || settingUp}
            onClick={tracker.refresh}
            title={copy.refresh}
            type="button"
          >
            <Icon className={reading ? "limits-spinner" : undefined} name="reload" />
            <span>{copy.refresh}</span>
          </button>
        </header>

        {!snapshot && reading ? <div className="limits-loading" role="status">{copy.loading}</div> : null}
        {readError !== null ? (
          <div className="limits-error" role="alert">
            <Icon name="alert" />
            <div><strong>{snapshot ? copy.staleError : copy.loadError}</strong>{readError ? <p>{localizeMessage(readError, language)}</p> : null}</div>
          </div>
        ) : null}
        {error ? <div className="limits-error" role="alert"><Icon name="alert" /><p>{localizeMessage(error, language)}</p></div> : null}

        {snapshot ? (
          <section aria-label={stateLabel} className={`limits-setup${zeroRisk || unsupported ? " is-unavailable" : ""}`}>
            <div className="limits-setup-main">
              <div className="limits-state" role="status">
                <i className={tracking ? "is-on" : ""} aria-hidden="true" />
                <span>{stateLabel}</span>
              </div>
              <h2>{zeroRisk ? copy.zeroRisk : unsupported ? copy.proOnly : tracking ? planLabel : copy.setupTitle}</h2>
              <p>{zeroRisk ? copy.zeroRiskBody : unsupported ? copy.unsupportedBody : tracking ? copy.observedBody : copy.setupBody}</p>
              {snapshot.checkedAt !== null ? <p className="limits-checked">{copy.checked}: {date(snapshot.checkedAt)}</p> : null}
            </div>
            <div className="limits-setup-action">
              <button
                aria-describedby={runtimeBusy && !zeroRisk ? "limits-busy" : undefined}
                aria-busy={settingUp}
                className={tracking || zeroRisk || unsupported ? "button-secondary" : "button-primary"}
                disabled={setupDisabled}
                onClick={() => void setup()}
                type="button"
              >
                {settingUp ? <Icon className="limits-spinner" name="reload" /> : null}
                {settingUp ? copy.checking : snapshot.checkedAt !== null ? copy.recheck : copy.setup}
              </button>
            </div>
            {runtimeBusy && !zeroRisk ? <p className="limits-busy" id="limits-busy">{copy.browserBusy}</p> : null}
          </section>
        ) : null}

        {tracking && snapshot ? (
          <section aria-labelledby="limits-observed-title" className="limits-observed">
            <div className="limits-section-heading">
              <h2 id="limits-observed-title">{copy.observedTitle}</h2>
              <span className="limits-tag">{copy.estimate}</span>
            </div>
            <div className="limits-scope">
              <Icon name="info" />
              <div><strong>{copy.scopeTitle}</strong><p>{copy.scopeBody}</p></div>
            </div>
            <div className="limits-window-grid">
              {snapshot.windows.map((window) => (
                <UsageWindow
                  copy={copy}
                  key={window.id}
                  number={number}
                  unknownModel={window.uncertainUsed > 0 && window.model !== "shared"}
                  window={window}
                />
              ))}
            </div>
            {snapshot.unknownProMessages > 0 ? <p className="limits-attribution">{copy.attributionBody}</p> : null}
            {snapshot.windows.length === 0 ? <p className="limits-muted">{copy.noWindows}</p> : null}
          </section>
        ) : null}

        {snapshot && snapshot.trackingSince !== null ? (
          <section aria-labelledby="limits-history-title" className="limits-history">
            <div className="limits-section-heading"><h2 id="limits-history-title">{copy.history}</h2></div>
            <p className="limits-section-description">{copy.historyBody}</p>
            <dl className="limits-history-grid">
              <div><dt>{copy.totalMessages}</dt><dd className="limits-history-count">{number(snapshot.totalMessages)}</dd></div>
              <div><dt>{copy.unknownPro}</dt><dd className="limits-history-count">{number(snapshot.unknownProMessages)}</dd></div>
              <div><dt>{copy.since}</dt><dd>{date(snapshot.trackingSince)}</dd></div>
            </dl>
            {snapshot.unknownProMessages > 0 ? <p className="limits-muted">{copy.unknownProBody}</p> : null}
          </section>
        ) : null}

        <section aria-labelledby="limits-reference-title" className="limits-reference">
          <div className="limits-section-heading">
            <h2 id="limits-reference-title">{copy.referenceTitle}</h2>
            <span className="limits-tag">{copy.referenceOnly}</span>
          </div>
          <p className="limits-section-description">{copy.referenceBody}</p>
          <div className="limits-reference-grid">
            <article className="limits-reference-plan">
              <h3>Pro $200</h3>
              <dl>
                <div><dt>GPT-6 Pro</dt><dd>{copy.week.replace("{count}", number(policy.pro_200.gpt6Weekly))}</dd></div>
                <div><dt>GPT-5.6 Sol Pro</dt><dd>{copy.day.replace("{count}", number(policy.pro_200.solDaily))}</dd></div>
                <div className="limits-reference-shared"><dt>{copy.combined}</dt><dd>{copy.day.replace("{count}", number(policy.pro_200.combinedDaily))}</dd></div>
              </dl>
            </article>
            <article className="limits-reference-plan">
              <h3>Pro $100</h3>
              <dl><div><dt>{copy.shared}</dt><dd>{copy.week.replace("{count}", number(policy.pro_100.combinedWeekly))}</dd></div></dl>
              <p className="limits-models">GPT-6 Pro + GPT-5.6 Sol Pro</p>
            </article>
            <article className="limits-reference-plan is-reference-only">
              <h3>Business</h3>
              <dl>
                <div><dt>{copy.businessStandard}</dt><dd>{copy.month.replace("{count}", number(policy.business.standardMonthly))}</dd></div>
                <div><dt>{copy.businessPremium}</dt><dd>{copy.week.replace("{count}", number(policy.business.premiumWeekly))}</dd></div>
              </dl>
              <p>{copy.shared}</p>
              <p>{copy.businessBody}</p>
            </article>
            <article className="limits-reference-plan is-unavailable">
              <h3>{copy.otherPlans}</h3>
              <span className="limits-unknown">{copy.unknown}</span>
              <p>{copy.otherPlansBody}</p>
            </article>
          </div>
          <footer className="limits-reference-footer">
            <span>{copy.asOf.replace("{date}", new Intl.DateTimeFormat(language, {
              dateStyle: "medium", timeZone: "UTC",
            }).format(new Date(`${policy.checkedOn}T00:00:00Z`)))}</span>
            <button className="text-button limits-source" onClick={() => void openReference()} type="button">
              {copy.source}<Icon name="external" />
            </button>
          </footer>
        </section>
      </div>
    </section>
  );
}

function UsageWindow({ copy, number, unknownModel, window }: {
  copy: LimitsCopy;
  number: (value: number) => string;
  unknownModel: boolean;
  window: LimitsWindow;
}) {
  const title = window.model === "gpt-6-pro" ? "GPT-6 Pro" : window.model === "gpt-5.6-pro" ? "GPT-5.6 Sol Pro" : copy.combined;
  const duration = window.durationMs === DAY_MS ? copy.rollingDay : window.durationMs === 7 * DAY_MS ? copy.rollingWeek
    : copy.rollingHours.replace("{hours}", number(window.durationMs / 3_600_000));
  return (
    <article className="limits-window">
      <h3>{title}</h3>
      <p className="limits-window-duration">{duration}</p>
      <div className={`limits-window-value${unknownModel ? " is-lower-bound" : ""}`}>
        <strong>{unknownModel ? copy.lowerBound.replace("{count}", number(window.used)) : number(window.used)}</strong>
        <span>{copy.observed}</span>
        {limitNeedsAttention(window) ? (
          <span className="limits-warning" role="img" aria-label={copy.nearLimit} title={copy.nearLimit}>
            <i aria-hidden="true" className="action-dot is-optional" />
          </span>
        ) : null}
      </div>
      {unknownModel ? <p className="limits-window-uncertain">{copy.modelTotalUnknown}</p> : (
        <div aria-hidden="true" className="limits-meter">
          <span style={{ width: `${window.limit > 0 ? Math.min(100, Math.max(0, window.used / window.limit * 100)) : 0}%` }} />
        </div>
      )}
      <p className="limits-window-reference">{copy.referenceCap.replace("{count}", number(window.limit))}</p>
      {window.uncertainUsed > 0 ? (
        <p className="limits-window-uncertain">
          {(window.model === "shared" ? copy.sharedUnknown : copy.uncertain).replace("{count}", number(window.uncertainUsed))}
        </p>
      ) : null}
    </article>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause ?? "");
}
