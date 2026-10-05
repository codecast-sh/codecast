// Connections: the person's Google account, what each part of it lets the
// assistant do, and connect or disconnect. The flows are the app's own
// (useLaneGoogle over lib/integrations useAppConnection); the Google
// callback lands back here (GOOGLE_RETURN_PATHS) and ConnectNotice finishes
// it in this signed-in tab.
import { useState } from "react";
import { CalendarDays, CircleAlert, Mail } from "lucide-react";
import { ConnectNotice } from "../../../components/simple/ConnectNotice";
import { Service } from "../../../components/simple/Service";
import { LANE_COPY, LANE_PATHS, connectionControls, plainConnectError } from "../../../components/simple/lane";
import { MAIL_COMING } from "../../../components/simple/assistantPromise";
import { useLaneGoogle } from "../../../components/simple/useLaneGoogle";
import { calendarAbility, disconnectNote, emailAbility } from "../../../components/simple/connectionWords";

const WORDS = LANE_COPY.connections;

export default function SimpleConnections() {
  const google = useLaneGoogle(LANE_PATHS.connections);
  const { others, actions, connected, can, email } = google;
  const [confirming, setConfirming] = useState(false);
  const controls = connectionControls(google, confirming);
  const error = plainConnectError(actions.error);

  return (
    <main>
      <h1 className="sl-page-title sl-rise">{WORDS.title}</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        {WORDS.lede(can)}
      </p>

      <ConnectNotice success={WORDS.success} />

      <section className="sl-card sl-rise" style={{ ["--i" as any]: 2, overflow: "hidden" }} aria-label={WORDS.google}>
        <div style={{ padding: "1rem 1.05rem 0.2rem", display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.12rem", fontWeight: 640, letterSpacing: "-0.01em" }}>{WORDS.google}</h2>
          <span className="sl-faint" style={{ fontSize: "0.88rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {connected ? email ?? WORDS.connected : WORDS.notConnected}
          </span>
        </div>
        <Service icon={<Mail size={19} />} title={WORDS.email} on={!!can?.read_mail}>
          {emailAbility(can)}
        </Service>
        <Service icon={<CalendarDays size={19} />} title={WORDS.calendar} on={!!can?.calendar}>
          {calendarAbility(can)}
        </Service>
        {error ? (
          <div className="sl-callout is-sun" style={{ margin: "0 1.05rem 0.9rem" }}>
            <CircleAlert size={18} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="sl-actions">
          {controls.coming ? <span className="sl-muted" style={{ alignSelf: "center", fontSize: "0.9rem" }}>{MAIL_COMING}</span> : null}
          {controls.connect ? (
            <button type="button" className="sl-btn is-yes" disabled={actions.busy} onClick={() => void actions.connect()}>
              {WORDS.connect}
            </button>
          ) : null}
          {controls.allow ? (
            <button type="button" className="sl-btn is-yes" disabled={actions.busy} onClick={() => void actions.connect()}>
              {WORDS.allow}
            </button>
          ) : null}
          {controls.confirm ? (
            <>
              <span className="sl-muted" style={{ alignSelf: "center", fontSize: "0.9rem" }}>{WORDS.disconnectAsk(email)}</span>
              <button type="button" className="sl-btn is-danger" disabled={actions.busy} onClick={() => {
                // The row settles at once; a refusal shows through actions.error.
                setConfirming(false);
                actions.disconnect().catch(() => {});
              }}>
                {WORDS.disconnect}
              </button>
              <button type="button" className="sl-btn is-no" onClick={() => setConfirming(false)}>{WORDS.keep}</button>
            </>
          ) : null}
          {controls.disconnect ? (
            <button type="button" className="sl-btn is-no" disabled={controls.disconnect === "off"} onClick={() => setConfirming(true)}>
              {WORDS.disconnect}
            </button>
          ) : null}
        </div>
      </section>

      {controls.coming ? null : (
        <p className="sl-faint sl-rise" style={{ ["--i" as any]: 3, fontSize: "0.86rem", marginTop: "1rem" }}>
          {disconnectNote(connected, email, others)}
        </p>
      )}
    </main>
  );
}
