// Connections: the person's Google account, what each part of it lets the
// assistant do, and connect or disconnect. The flows are the app's own
// (useLaneGoogle over lib/integrations useAppConnection); the Google
// callback lands back here (GOOGLE_RETURN_PATHS) and ConnectNotice finishes
// it in this signed-in tab.
import { useState } from "react";
import { CalendarDays, CircleAlert, Mail } from "lucide-react";
import { ConnectNotice } from "../../../components/simple/ConnectNotice";
import { LANE_PATHS, missingAbilities, plainConnectError } from "../../../components/simple/lane";
import { useLaneGoogle } from "../../../components/simple/useLaneGoogle";

function Service({ icon, title, on, children }: { icon: React.ReactNode; title: string; on: boolean; children: React.ReactNode }) {
  return (
    <div className="sl-service">
      <span className={`sl-service-icon${on ? "" : " is-sun"}`} aria-hidden>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <h3>
          {title}
          <span className={`sl-pill${on ? "" : " is-off"}`}>{on ? "On" : "Off"}</span>
        </h3>
        <p>{children}</p>
      </div>
    </div>
  );
}

export default function SimpleConnections() {
  const { gmail, others, actions, connected, can, email } = useLaneGoogle(LANE_PATHS.connections);
  const [confirming, setConfirming] = useState(false);
  const error = plainConnectError(actions.error);

  return (
    <main>
      <h1 className="sl-page-title sl-rise">Connections</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        What I can see and do for you. I always ask before sending an email or changing your calendar.
      </p>

      <ConnectNotice success="Google is connected. Try asking me what needs a reply this week." />

      <section className="sl-card sl-rise" style={{ ["--i" as any]: 2, overflow: "hidden" }} aria-label="Google">
        <div style={{ padding: "1rem 1.05rem 0.2rem", display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.12rem", fontWeight: 640, letterSpacing: "-0.01em" }}>Google</h2>
          <span className="sl-faint" style={{ fontSize: "0.88rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {connected ? email ?? "Connected" : "Not connected"}
          </span>
        </div>
        <Service icon={<Mail size={19} />} title="Email" on={!!can?.read_mail}>
          {!can?.read_mail
            ? "Read and sort your mail, find what needs you, and draft replies."
            : can.modify_mail && can.send_mail
              ? "I read and sort your mail and draft replies. I send only after you say yes."
              : can.send_mail
                ? "I can read your mail and send replies after you say yes. Sorting, archiving and labels need one more permission."
                : "I can read your mail. Sorting it and sending replies need one more permission."}
        </Service>
        <Service icon={<CalendarDays size={19} />} title="Calendar" on={!!can?.calendar}>
          {can?.calendar
            ? "I see when you're free, and add or move events after you say yes."
            : "See when you're free, find times to meet, and add events for you."}
        </Service>
        {error ? (
          <div className="sl-callout is-sun" style={{ margin: "0 1.05rem 0.9rem" }}>
            <CircleAlert size={18} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="sl-actions">
          {!connected ? (
            <button type="button" className="sl-btn is-yes" disabled={actions.busy} onClick={() => void actions.connect()}>
              Connect Google
            </button>
          ) : (
            <>
              {missingAbilities(can) ? (
                <button type="button" className="sl-btn is-yes" disabled={actions.busy} onClick={() => void actions.connect()}>
                  Allow email and calendar
                </button>
              ) : null}
              {confirming ? (
                <>
                  <span className="sl-muted" style={{ alignSelf: "center", fontSize: "0.9rem" }}>Disconnect {email ?? "Google"}?</span>
                  <button type="button" className="sl-btn is-danger" disabled={actions.busy} onClick={() => {
                    // The row settles at once; a refusal shows through actions.error.
                    setConfirming(false);
                    actions.disconnect().catch(() => {});
                  }}>
                    Disconnect
                  </button>
                  <button type="button" className="sl-btn is-no" onClick={() => setConfirming(false)}>Keep it</button>
                </>
              ) : (
                <button type="button" className="sl-btn is-no" disabled={!gmail || gmail.status !== "connected" || !gmail.disconnect_id} onClick={() => setConfirming(true)}>
                  Disconnect
                </button>
              )}
            </>
          )}
        </div>
      </section>

      <p className="sl-faint sl-rise" style={{ ["--i" as any]: 3, fontSize: "0.86rem", marginTop: "1rem" }}>
        {connected && others.length > 0
          ? `Disconnecting ${email ?? "this account"} stops me from using it right away. Your other Google ${others.length === 1 ? "account stays" : "accounts stay"} connected, and I would use ${others[0].email ?? "that one"} instead. Nothing already written is deleted.`
          : "Disconnecting stops me from reading or sending anything right away. Nothing already written is deleted."}
      </p>
    </main>
  );
}
