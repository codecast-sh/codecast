import { useState } from "react";
import { isDesktopShell, openExternalUrl } from "./desktop";
import { describeConnectorError } from "./connectorReturn";

// The connect gesture's own machinery, apart from lib/integrations because
// that module also holds the web's icon table (APP_LOOK, from lucide-react)
// and the phone reaches this half: mobile's settings screen renders the shared
// components/simple/useLaneMail.ts, which connects mail through Whisk. An
// import of the icon-bearing module from there resolves lucide-react out of
// packages/web/node_modules and bundles all ~3,800 icons into the native app
// (the class of incident CLAUDE.md records for `@sentry/react`, and the reason
// `lucide-react` is named in mobile's lib/bundleGraph.guard.test.ts).
// lib/integrations re-exports both of these, so a web caller can keep reading
// them there.

/** Open a connect URL the server minted. On the web `sameTab` opens it in
 *  place: a tab opened once the URL arrives is outside the tap's user
 *  activation, and phone browsers block it silently. The desktop app always
 *  hands it to the system browser. */
export function openConnectUrl(url: string, sameTab = false): void {
  if (sameTab && !isDesktopShell()) window.location.assign(url);
  else openExternalUrl(url);
}

/**
 * The machinery every connect gesture shares: a busy flag, the last refusal
 * in plain words (describeConnectorError), `attempt` to run a step holding
 * both, and `openMinted` to open the authorize URL a server minted or report
 * why it minted none. useAppConnection and the mail connect through Whisk
 * (components/simple/useLaneMail.ts) both build on it.
 */
export function useConnectGesture() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run `fn`, holding the busy flag and reporting whatever it throws. */
  const attempt = async (fn: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message ?? fallback);
    } finally {
      setBusy(false);
    }
  };

  /** Report a `{ ok: false, error }` answer; true when the step succeeded. */
  const settle = (res: { ok?: boolean; error?: string } | null | undefined, fallback: string) => {
    if (res?.ok) return true;
    setError(res?.error ?? fallback);
    return false;
  };

  /** Open an authorize URL the server minted, or report why it minted none. */
  const openMinted = async (
    mint: () => Promise<{ ok?: boolean; url?: string; error?: string } | null>,
    fallback: string,
    { sameTab = false }: { sameTab?: boolean } = {},
  ) => {
    const res = await mint();
    if (settle(res && { ...res, ok: !!(res.ok && res.url) }, fallback)) openConnectUrl(res!.url!, sameTab);
  };

  return { busy, error: error && describeConnectorError(error), setError, attempt, settle, openMinted };
}
