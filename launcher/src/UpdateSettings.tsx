import { useEffect, useState } from "react";
import type { Copy } from "./i18n";
import type { Language, UpdateState } from "./types";

export function UpdateSettings({ copy, language, update, version, onCheck, setError }: {
  copy: Copy;
  language: Language;
  update: UpdateState;
  version: string;
  onCheck: () => Promise<UpdateState>;
  setError: (message: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const retryAt = update.status === "error" ? update.retryAt : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (!retryAt || retryAt <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), retryAt - Date.now());
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  const checking = pending || update.status === "checking";
  const busy = checking || update.status === "downloading" || update.status === "installing";
  const message = update.status === "error" ? update.message
    : update.status === "up-to-date" ? copy.upToDate
    : "version" in update ? `${copy.updateAvailable} v${update.version}`
    : `v${version}`;
  const check = async () => {
    setPending(true);
    try { await onCheck(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return <div className="setting-row">
    <div>
      <strong>{copy.updates}</strong>
      <p role="status">{message}</p>
      {retryAt && retryAt > now ? <p>{copy.updateRetryAfter.replace("{time}",
        new Date(retryAt).toLocaleString(language))}</p> : null}
    </div>
    <button className="button-secondary" type="button"
      disabled={busy || (retryAt !== undefined && retryAt > now)} onClick={() => void check()}>
      {checking ? copy.checkingUpdates : copy.checkUpdates}
    </button>
  </div>;
}
