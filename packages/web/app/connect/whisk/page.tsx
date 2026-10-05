// /connect/whisk: where Whisk sends the browser back after the person
// approves (or declines) connecting their mail and calendar. Whisk registers
// exactly this path on codecast.sh, and its query carries a one-time code
// (`whisk_code`) and our signed `state`. This page reads them once, clears
// them from the address bar (the code is a credential), and hands them to
// whisk.finishConnect from the signed-in session, which checks the state
// names this person, trades the code server to server and stores the token.
// Then it lands on the lane page the connect started from, which says how it
// went (ConnectNotice).
import { useRef, useState } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { Link, useNavigate } from "react-router";
import { api } from "@codecast/convex/convex/_generated/api";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { WHISK_RETURN_KEY } from "../../../lib/connectorReturn";
import { LANE_COPY, LANE_PATHS } from "../../../components/simple/lane";
import { useLaneDocumentTitle } from "../../../components/simple/useLaneTitle";
import "../../../components/simple/laneLook";
import "../../../components/simple/simple.css";

/** Whisk's return, read once: the code, our state, or Whisk's error. */
function readReturn() {
  const query = new URLSearchParams(window.location.search);
  const read = {
    code: query.get("whisk_code") ?? undefined,
    state: query.get("state") ?? undefined,
    error: query.get("error") ?? undefined,
  };
  window.history.replaceState(null, "", window.location.pathname);
  return read;
}

/** The lane page with the outcome on it. */
function landing(returnTo: string, ok: boolean, reason?: string): string {
  const query = new URLSearchParams(ok ? { [WHISK_RETURN_KEY]: "connected" } : { [WHISK_RETURN_KEY]: "error", ...(reason ? { reason } : {}) });
  return `${returnTo}?${query.toString()}`;
}

export default function WhiskReturn() {
  useLaneDocumentTitle(LANE_COPY.connections.mail);
  const finish = useAction(api.whisk.finishConnect);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const navigate = useNavigate();
  const [received] = useState(readReturn);
  const started = useRef(false);
  const [signedOut, setSignedOut] = useState(false);

  useWatchEffect(() => {
    if (started.current || isLoading) return;
    started.current = true;
    if (!isAuthenticated) {
      setSignedOut(true);
      return;
    }
    void finish(received)
      .then((res) => navigate(landing(res.return_to, res.ok, res.reason), { replace: true }))
      .catch(() => navigate(landing(LANE_PATHS.connections, false), { replace: true }));
  }, [isLoading, isAuthenticated]);

  return (
    <div data-simple-lane>
      <main className="sl-frame" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", textAlign: "center" }}>
        {signedOut ? (
          <div className="sl-rise">
            <p className="sl-lede">Sign in to codecast in this browser, then connect your mail and calendar again.</p>
            <Link className="sl-btn is-yes" to={LANE_PATHS.welcome}>Sign in</Link>
          </div>
        ) : (
          <p className="sl-lede" role="status">Connecting your mail and calendar</p>
        )}
      </main>
    </div>
  );
}
