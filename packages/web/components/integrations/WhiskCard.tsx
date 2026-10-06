// Mail and calendar on the Integrations page: the person's mail, connected
// through Whisk (the family's mail app, convex/whisk.ts), what the grant lets
// the assistant do, the mailboxes it reaches, and connect, disconnect and
// Open Whisk. It reads the same hook and words as /welcome and the phone
// (useLaneMail, connectionWords, LANE_COPY.connections), drawn in the
// integrations ledger's grammar. Whisk's approval comes back through
// /connect/whisk to Settings > Integrations, and the shell toasts how it went
// (ConnectToast).
import { CalendarDays, ExternalLink, Mail } from "lucide-react";
import type { WhiskReturnPath } from "@codecast/convex/convex/whisk";
import { calendarAbility, disconnectNote, emailAbility, mailboxLine } from "../simple/connectionWords";
import { LANE_COPY, connectionControls, plainConnectError } from "../simple/lane";
import { useLaneMail } from "../simple/useLaneMail";
import { settingsPathFor } from "../../lib/settingsSections";
import { ConfirmButton, LedgerLine, QuietButton, StatusDot } from "./parts";

const WORDS = LANE_COPY.connections;
const RETURN_TO = settingsPathFor("integrations") as WhiskReturnPath;

/** "Mail and calendar (Whisk)": the row's name, the product and its mail app. */
export const WHISK_CARD_TITLE = `${WORDS.mail} (Whisk)`;

function Ability({ icon: Icon, title, on, children }: { icon: typeof Mail; title: string; on: boolean | null; children: string }) {
  return (
    <li className="flex gap-2 text-[11px] leading-snug text-sol-text-muted">
      <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-sol-text-dim" aria-hidden />
      <span>
        <span className="font-medium text-sol-text">{title}</span>
        {on === null ? null : <span className={on ? "text-sol-green" : "text-sol-text-dim"}>{` ${on ? WORDS.on : WORDS.off}`}</span>}
        {`: ${children}`}
      </span>
    </li>
  );
}

/** The one way in when nothing is connected: the family's primary button,
 *  as /welcome draws the same action. */
function ConnectButton({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-9 items-center rounded-[var(--pd-radius,8px)] px-4 text-[13px] font-semibold transition-[filter,opacity] hover:brightness-110 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--pd-accent,var(--sol-orange))]"
      style={{ background: "var(--pd-accent, var(--sol-orange))", color: "var(--pd-accent-ink, #fff)" }}
    >
      {busy ? LANE_COPY.connections.opening : children}
    </button>
  );
}

export function WhiskCard() {
  const mail = useLaneMail(RETURN_TO);
  const { actions, connected, can, email, mailboxes, whiskUrl, known } = mail;
  const controls = connectionControls(mail, false);
  const error = plainConnectError(actions.error);

  return (
    <div className="px-4 py-3.5 sm:px-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-sol-border bg-sol-bg-alt text-sol-text-muted">
          <Mail className="h-4 w-4" />
        </span>
        <span className="min-w-0 text-sm font-semibold leading-snug tracking-tight text-sol-text">{WHISK_CARD_TITLE}</span>
        <span className="flex-1" />
        <StatusDot tone={known && connected && !controls.reconnect ? "ok" : "idle"}>
          {!known ? WORDS.checking : controls.reconnect ? WORDS.needsReconnect : connected ? WORDS.connected : controls.coming ? WORDS.coming : WORDS.notConnected}
        </StatusDot>
      </div>

      {connected ? <LedgerLine className="mt-1.5" parts={[mailboxLine(email, mailboxes), WORDS.through.toLowerCase()]} /> : null}

      <p className="mt-1.5 text-xs leading-relaxed text-sol-text-muted">{WORDS.whiskNote}</p>

      <ul className="mt-2 space-y-1">
        <Ability icon={Mail} title={WORDS.email} on={connected ? !!can?.read_mail : null}>{emailAbility(can)}</Ability>
        <Ability icon={CalendarDays} title={WORDS.calendar} on={connected ? !!can?.calendar : null}>{calendarAbility(can)}</Ability>
      </ul>

      {error ? <p className="mt-1.5 break-words text-[11px] leading-relaxed text-sol-red">{error}</p> : null}

      {/* Until the connection and the deployment have answered, the row
          offers nothing it may have to withdraw: a quiet block holds the
          button's place, so the card keeps its height when the answer lands. */}
      {!known ? <div aria-hidden className="mt-2.5 h-9 w-44 rounded-[var(--pd-radius,8px)] bg-sol-bg-inset" /> : null}
      {known ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {controls.coming ? <span className="text-[11px] text-sol-text-dim">{WORDS.comingNote}</span> : null}
          {controls.connect ? <ConnectButton onClick={() => void actions.connect()} busy={actions.busy}>{WORDS.connect}</ConnectButton> : null}
          {controls.reconnect ? <ConnectButton onClick={() => void actions.connect()} busy={actions.busy}>{WORDS.reconnect}</ConnectButton> : null}
          {controls.allow ? <QuietButton onClick={() => void actions.connect()} busy={actions.busy}>{WORDS.allow}</QuietButton> : null}
          {connected ? (
            <a href={whiskUrl} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-sol-border px-2.5 text-xs text-sol-text transition-colors hover:bg-sol-bg-highlight">
              {WORDS.openWhisk}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : null}
          {controls.disconnect === "on" ? (
            <ConfirmButton label={WORDS.disconnect} question={WORDS.disconnectAsk(email)} onConfirm={() => void actions.disconnect()} busy={actions.busy} busyLabel="Disconnecting" />
          ) : null}
        </div>
      ) : null}

      {known && (controls.connect || connected) ? <p className="mt-2 text-[11px] leading-relaxed text-sol-text-dim">{disconnectNote(connected)}</p> : null}
    </div>
  );
}
