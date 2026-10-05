// /welcome: where someone new to codecast starts (plan pl-840 onboarding:
// sign in, connect, first useful thing). A placeholder in the simple lane's
// voice until the onboarding screens land here; it already sends a signed-in
// person on to their assistant and everyone else to sign in. It is also a
// page Google's connect may return to (googleOAuth.ts GOOGLE_RETURN_PATHS),
// so it mounts ConnectNotice, which runs the confirm step, like every such page.
import { Link } from "react-router";
import { useLocalAuth } from "../../lib/localAuth";
import { LANE_PATHS } from "../../components/simple/lane";
import { ConnectNotice } from "../../components/simple/ConnectNotice";
import { useLaneFont } from "../../components/simple/useLaneFont";
import "../../components/simple/simple.css";

export default function Welcome() {
  const isAuthenticated = useLocalAuth();
  useLaneFont();
  return (
    <div data-simple-lane>
      <div className="sl-frame" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "100dvh" }}>
        <span className="sl-brand sl-rise" style={{ marginBottom: "2rem" }}>
          <span className="sl-brand-mark" aria-hidden />
          <span>codecast</span>
        </span>
        <h1 className="sl-hello sl-rise" style={{ ["--i" as any]: 1, marginTop: 0 }}>An assistant for the busywork.</h1>
        <p className="sl-lede sl-rise" style={{ ["--i" as any]: 2 }}>
          It reads your mail, finds times on your calendar and handles the follow-ups, and it asks you before anything goes out.
        </p>
        <ConnectNotice success="Google is connected." />
        <div className="sl-rise" style={{ ["--i" as any]: 3, display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          {isAuthenticated ? (
            <Link to={LANE_PATHS.home} className="sl-btn is-yes">Go to your assistant</Link>
          ) : (
            <>
              <Link to={`/login?return_to=${encodeURIComponent(LANE_PATHS.home)}`} className="sl-btn is-yes">Sign in</Link>
              <Link to={`/signup?return_to=${encodeURIComponent(LANE_PATHS.home)}`} className="sl-btn is-plain">Create an account</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
