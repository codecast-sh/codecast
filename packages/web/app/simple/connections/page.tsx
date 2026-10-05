// Connections: the person's mail and calendar, connected through Whisk (the
// family's mail app), what each part lets the assistant do, and connect,
// disconnect or open Whisk itself. The gestures are useLaneMail's; Whisk's
// approval comes back through /connect/whisk to this page, and ConnectNotice
// says how it went. Whisk opens in a new tab; the desktop app sends every
// such link to the system browser itself (electron/main.js).
import { useState } from "react";
import { CalendarDays, CircleAlert, ExternalLink, Mail } from "lucide-react";
import { ConnectNotice } from "../../../components/simple/ConnectNotice";
import { Service } from "../../../components/simple/Service";
import { LANE_COPY, LANE_PATHS, connectionControls, plainConnectError } from "../../../components/simple/lane";
import { MAIL_COMING } from "../../../components/simple/assistantPromise";
import { useLaneMail } from "../../../components/simple/useLaneMail";
import { calendarAbility, disconnectNote, emailAbility, mailboxLine } from "../../../components/simple/connectionWords";

const WORDS = LANE_COPY.connections;

export default function SimpleConnections() {
  const mail = useLaneMail(LANE_PATHS.connections);
  const { actions, connected, can, email, mailboxes, whiskUrl, known } = mail;
  const [confirming, setConfirming] = useState(false);
  const controls = connectionControls(mail, confirming);
  const error = plainConnectError(actions.error);

  return (
    <main>
      <h1 className="sl-page-title sl-rise">{WORDS.title}</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        {WORDS.lede(can)}
      </p>

      <ConnectNotice success={WORDS.success} />

      <section className="sl-card sl-rise" style={{ ["--i" as any]: 2, overflow: "hidden" }} aria-label={WORDS.mail}>
        <div style={{ padding: "1rem 1.05rem 0.2rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
            <h2 style={{ margin: 0, fontSize: "1.12rem", fontWeight: 640, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>{WORDS.mail}</h2>
            <span className="sl-faint" style={{ fontSize: "0.88rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {!known ? "" : connected ? mailboxLine(email, mailboxes) ?? WORDS.connected : WORDS.notConnected}
            </span>
          </div>
          <p className="sl-faint" style={{ margin: "0.15rem 0 0", fontSize: "0.86rem" }}>{WORDS.through}</p>
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
        {/* Until the connection and the deployment have answered, the row
            holds a button's height empty rather than offer a button it may
            have to withdraw. */}
        <div className="sl-actions">
          {!known ? (
            <span className="sl-btn" aria-hidden style={{ visibility: "hidden" }}>{WORDS.connect}</span>
          ) : (
            <>
              {controls.coming ? <span className="sl-muted" style={{ display: "inline-flex", alignItems: "center", minHeight: "2.6rem", fontSize: "0.9rem" }}>{MAIL_COMING}</span> : null}
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
                    void actions.disconnect();
                  }}>
                    {WORDS.disconnect}
                  </button>
                  <button type="button" className="sl-btn is-no" onClick={() => setConfirming(false)}>{WORDS.keep}</button>
                </>
              ) : null}
              {connected && !controls.confirm ? (
                <a className="sl-btn is-no" href={whiskUrl} target="_blank" rel="noreferrer">
                  {WORDS.openWhisk}
                  <ExternalLink size={15} aria-hidden />
                </a>
              ) : null}
              {controls.disconnect ? (
                <button type="button" className="sl-btn is-no" disabled={controls.disconnect === "off"} onClick={() => setConfirming(true)}>
                  {WORDS.disconnect}
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      {known && (controls.connect || connected) ? (
        <p className="sl-faint sl-rise" style={{ ["--i" as any]: 3, fontSize: "0.86rem", marginTop: "1rem" }}>
          {disconnectNote(connected)}
        </p>
      ) : null}
      {known && !controls.coming ? (
        <p className="sl-faint sl-rise" style={{ ["--i" as any]: 4, fontSize: "0.86rem", marginTop: "0.5rem" }}>
          {WORDS.whiskNote}
          {/* Connected, the card carries the Open Whisk button. */}
          {connected ? null : (
            <>
              {" "}
              <a href={whiskUrl} target="_blank" rel="noreferrer" style={{ color: "var(--sl-accent-text)", textDecoration: "underline", textUnderlineOffset: "0.15em" }}>{WORDS.openWhisk}</a>
            </>
          )}
        </p>
      ) : null}
    </main>
  );
}
