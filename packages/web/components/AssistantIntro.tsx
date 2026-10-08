// What the hosted assistant does, said where a person starts with it: the
// compose popup's empty state (HostedComposeIntro in sessionControls) and an
// empty inbox in hosted mode (EmptyState). Mail and calendar are named only
// once Whisk is connected; until then a quiet link starts the connect, where
// this deployment can make one (connectionControls, the same rule the lane's
// Connections page reads), which comes back to `returnTo`: the inbox, where
// the shell says how it went (ConnectToast).
//
// Two ways to start. `onStarter` hands a starter's request (LANE_COPY.home
// .starters) to a composer for the person to finish or send; the compose
// sheet offers these only while the person is new to the assistant. `onAsk`
// sends a whole ask at once. Both draw from one pool (simple/starterPool,
// which the phone's compose sheet reads too).
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useLaneMail } from "./simple/useLaneMail";
import { LANE_COPY, connectionControls, plainConnectError } from "./simple/lane";
import { useStarterPool } from "./simple/starterPool";
import { AskHeldLine, useHostedAskGate } from "./simple/useHostedAskGate";
import type { WhiskReturnPath } from "@codecast/convex/convex/whisk";
import { LogoMark } from "./Logo";

/** One starter row, shared by the home and the compose sheet: plain text in
 *  body ink, a muted arrow at the end, a hairline between rows. */
function StarterRow({ label, title, onClick, disabled }: { label: string; title?: string; onClick: () => void; disabled?: boolean }) {
  // Two lines before it clips (three on a phone's narrow column): an ask's
  // assumptions (a short drive, for two) are what make it worth tapping, and
  // a truncated line hid them.
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="group flex w-full min-w-0 items-start gap-3 border-b border-sol-border/50 px-1 py-2 text-left text-sm text-sol-text transition-colors last:border-b-0 hover:bg-sol-bg-highlight/60 disabled:cursor-default disabled:text-sol-text-dim disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1 line-clamp-3 sm:line-clamp-2 [text-wrap:pretty]">{label}</span>
      <ArrowRight aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-transform group-hover:translate-x-0.5 group-disabled:opacity-0" />
    </button>
  );
}

export function AssistantIntro({ onStarter, onAsk, returnTo = "/inbox", title = LANE_COPY.intro.title, children, returning }: {
  onStarter?: (text: string) => void;
  /** The heading; the compose sheet names the assistant, the inbox's home asks. */
  title?: string;
  onAsk?: (text: string) => void;
  returnTo?: WhiskReturnPath;
  children?: ReactNode;
  /** What someone coming back returns to (their move, the next routine):
   *  leads the home once they are no longer new, and follows it before. */
  returning?: ReactNode;
}) {
  const mail = useLaneMail(returnTo);
  const { connect } = connectionControls(mail, false);
  const { newToAssistant, asks, starters } = useStarterPool(mail.connected, mail.can);
  // Asks unless a new ask is held (a used-up month, or thinking the
  // deployment says is down): the hold says why instead of offering asks
  // that could only stop.
  const hold = useHostedAskGate(!!onAsk);
  const connectError = plainConnectError(mail.actions.error);
  // The compose sheet (onStarter) hugs the composer under it, so its stack
  // sits at the foot of the sheet; the inbox's start centres in its pane.
  const sheet = !!onStarter;
  // `w-full min-w-0`: without them a starter's longest word sets the width,
  // and the centred column grows wider than a phone.
  return (
    <div className={`flex-1 flex w-full min-w-0 flex-col items-center gap-3 px-6 text-center ${sheet ? "justify-end pb-3" : "justify-center"}`} data-cc-intro={sheet ? "sheet" : "home"}>
      {/* The bare mark, as the rail's wordmark draws it. */}
      <LogoMark size={28} monochrome className="shrink-0 text-sol-text" />
      <p data-cc-intro-title className="text-lg font-medium text-sol-text [text-wrap:balance]">{title}</p>
      {!sheet && <p className="max-w-[34ch] text-sm text-sol-text-muted [text-wrap:balance]">{LANE_COPY.intro.lede(mail.connected)}</p>}
      {/* Someone new gets starters that ask them for the details; someone
          back gets a few whole asks, a routine among them, so the sheet
          shows the range of what it does. Either fills the composer. An
          errand they already have a conversation for is not offered again. */}
      {sheet && starters.length > 0 && (
        <div className="mt-1 flex w-full min-w-0 max-w-md flex-col text-left" role="list" aria-label="Ways to start">
          {starters.map((starter) => (
            <StarterRow
              key={starter.label}
              label={starter.label}
              title={starter.label === starter.text ? undefined : starter.text}
              onClick={() => onStarter(starter.text)}
            />
          ))}
        </div>
      )}
      {!newToAssistant && returning}
      {/* A held month keeps the asks in place, quiet and inert, so the page
          still reads as the home; the sentence and its link sit centred
          under the heading as one block. */}
      {onAsk && hold && <p role="status" className="mt-2 max-w-sm text-sm"><AskHeldLine hold={hold} className="flex-col justify-center text-center" /></p>}
      {onAsk && asks.length > 0 && (
        <div className="mt-2 flex w-full min-w-0 max-w-md flex-col text-left" role="list" aria-label="Things to ask" aria-disabled={hold ? true : undefined}>
          {asks.map((ask) => <StarterRow key={ask} label={ask} disabled={!!hold} onClick={() => onAsk(ask)} />)}
        </div>
      )}
      {children}
      {newToAssistant && returning}
      {connect && (
        <button
          type="button"
          onClick={mail.actions.connect}
          disabled={mail.actions.busy}
          className="text-xs text-sol-orange hover:underline disabled:opacity-60"
        >
          {mail.actions.busy ? LANE_COPY.connections.opening : LANE_COPY.connections.connect}
        </button>
      )}
      {connectError && <p role="alert" className="text-xs text-sol-text-muted">{connectError}</p>}
    </div>
  );
}
