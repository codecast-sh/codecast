// /connect/whisk: where Whisk sends the browser back after the person
// approves (or declines) connecting their mail and calendar. Whisk registers
// exactly this path on codecast.sh, and its query carries a one-time code
// (`whisk_code`) and our signed `state`. This page reads them once, clears
// them from the address bar (the code is a credential), and hands them to
// whisk.finishConnect from the signed-in session, which checks the state
// names this person, trades the code server to server and stores the token.
// Then it lands on the lane page the connect started from, which says how it
// went (ConnectNotice).
//
// A return can land in a browser not signed in to codecast: the desktop app
// opens the connect in the system browser. The return is then held in this
// tab (lib/returnStash.ts, as Slack's is), the person signs in, and sign-in
// brings them back here to finish while the code is still good.
import { useRef, useState } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { Link, useNavigate } from "react-router";
import { api } from "@codecast/convex/convex/_generated/api";
import { WHISK_RETURN_PATH } from "@codecast/convex/convex/lib/whisk";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { WHISK_RETURN_KEY } from "../../../lib/connectorReturn";
import { returnStash, type StashedReturn } from "../../../lib/returnStash";
import { LANE_COPY, LANE_PATHS } from "../../../components/simple/lane";
import { useLaneDocumentTitle } from "../../../components/simple/useLaneTitle";
import "../../../components/simple/laneLook";
import "../../../components/simple/simple.css";

const stash = returnStash("codecast-whisk-return", "Whisk");

/** Sign-in that comes back here to finish. */
export const WHISK_SIGN_IN_URL = `/login?reason=whisk&return_to=${encodeURIComponent(WHISK_RETURN_PATH)}`;

/** Whisk's return, read once: from the address bar when Whisk just sent the
 *  browser here (then cleared and held), or the one held across a sign-in.
 *  Sign-in's own return to this page carries none of Whisk's keys. */
function takeReturn(): StashedReturn | null {
  const query = new URLSearchParams(window.location.search);
  if (query.has("whisk_code") || (query.has("error") && query.has("state"))) {
    const ret = { code: query.get("whisk_code"), state: query.get("state"), error: query.get("error") };
    window.history.replaceState(null, "", window.location.pathname);
    stash.put(ret);
    return ret;
  }
  return stash.read("");
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
  const [pending] = useState(takeReturn);
  const started = useRef(false);
  const [signedOut, setSignedOut] = useState(false);

  useWatchEffect(() => {
    if (started.current) return;
    if (!pending) {
      started.current = true;
      navigate(landing(LANE_PATHS.connections, false, "bad_state"), { replace: true });
      return;
    }
    if (isLoading) return;
    started.current = true;
    if (!isAuthenticated) {
      // Held for after sign-in when the tab can keep it; otherwise the person
      // signs in here and starts the connect again.
      if (stash.canResume(pending)) navigate(WHISK_SIGN_IN_URL, { replace: true });
      else {
        stash.clear(pending);
        setSignedOut(true);
      }
      return;
    }
    void finish({ code: pending.code ?? undefined, state: pending.state ?? undefined, error: pending.error ?? undefined })
      .then((res) => navigate(landing(res.return_to, res.ok, res.reason), { replace: true }))
      .catch(() => navigate(landing(LANE_PATHS.connections, false), { replace: true }))
      .finally(() => stash.clear(pending));
  }, [pending, isLoading, isAuthenticated]);

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
