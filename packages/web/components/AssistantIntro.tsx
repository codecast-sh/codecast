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
// sends a first ask at once, the same asks /welcome's start screen offers
// (firstAsks), so both first-run entries behave alike.
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { useLaneMail } from "./simple/useLaneMail";
import { LANE_COPY, connectionControls, firstAsks, plainConnectError } from "./simple/lane";
import { ASKS } from "./simple/assistantPromise";
import { AskHeldLine, useHostedAskGate } from "./simple/useHostedAskGate";
import type { WhiskReturnPath } from "@codecast/convex/convex/whisk";
import { LogoMark } from "./Logo";
import { useInboxStore } from "../store/inboxStore";

/** Starters stop being offered once the person has this many conversations
 *  with the assistant: by then they know what to ask. */
const STARTERS_UNTIL = 3;
/** How many starters the compose sheet offers at once. */
const SHEET_STARTERS = 3;

function useNewToAssistant(): boolean {
  return useInboxStore((s) => {
    let seen = 0;
    for (const row of Object.values(s.sessions)) {
      if (isHostedAgentType(row?.agent_type) && ++seen >= STARTERS_UNTIL) return false;
    }
    return true;
  });
}

/** Whether a hosted conversation already began with this ask. */
function askedBefore(text: string): boolean {
  const sessions = useInboxStore.getState().sessions;
  for (const id in sessions) {
    const row = sessions[id];
    if (isHostedAgentType(row?.agent_type) && row?.last_user_message?.trim() === text.trim()) return true;
  }
  return false;
}

export function AssistantIntro({ onStarter, onAsk, returnTo = "/inbox", title = LANE_COPY.intro.title, children }: {
  onStarter?: (text: string) => void;
  /** The heading; the compose sheet names the assistant, the inbox's home asks. */
  title?: string;
  onAsk?: (text: string) => void;
  returnTo?: WhiskReturnPath;
  children?: ReactNode;
}) {
  const mail = useLaneMail(returnTo);
  const { connect } = connectionControls(mail, false);
  const newToAssistant = useNewToAssistant();
  const { lead, more } = firstAsks(mail.connected ? mail.can : null);
  const asks = lead ? [lead, ...more] : more;
  // Asks unless a new ask is held (a used-up month, or thinking the
  // deployment says is down): the hold says why instead of offering asks
  // that could only stop.
  const hold = useHostedAskGate(!!onAsk);
  const connectError = plainConnectError(mail.actions.error);
  // The compose sheet (onStarter) hugs the composer under it, so its stack
  // sits at the foot of the sheet; the inbox's start centres in its pane.
  const sheet = !!onStarter;
  // Up to SHEET_STARTERS the person has not asked yet; someone back draws
  // from every whole ask, so the sheet keeps offering a few.
  const starters = (newToAssistant
    ? LANE_COPY.home.starters(mail.connected)
    : [...new Set([...asks, ASKS.mondays, ASKS.sayNo, ASKS.compare, ASKS.trip])].map((ask) => ({ label: ask, text: ask })))
    .filter((starter) => !askedBefore(starter.text))
    .slice(0, SHEET_STARTERS);
  return (
    <div className={`flex-1 flex flex-col items-center gap-3 px-6 text-center ${sheet ? "justify-end pb-3" : "justify-center"}`} data-cc-intro={sheet ? "sheet" : "home"}>
      {/* The bare mark, as the rail's wordmark draws it. */}
      <LogoMark size={28} monochrome className="shrink-0 text-sol-text" />
      <p data-cc-intro-title className="text-lg font-medium text-sol-text">{title}</p>
      {!sheet && <p className="max-w-[34ch] text-sm text-sol-text-muted [text-wrap:balance]">{LANE_COPY.intro.lede(mail.connected)}</p>}
      {/* Someone new gets starters that ask them for the details; someone
          back gets a few whole asks, a routine among them, so the sheet
          shows the range of what it does. Either fills the composer. An
          errand they already have a conversation for is not offered again. */}
      {sheet && starters.length > 0 && (
        <div className="mt-1 flex w-full max-w-md flex-col text-left" role="list" aria-label="Ways to start">
          {starters.map((starter) => (
            <button
              key={starter.label}
              type="button"
              role="listitem"
              onClick={() => onStarter(starter.text)}
              title={starter.label === starter.text ? undefined : starter.text}
              className="w-full truncate rounded-[6px] px-2.5 py-1.5 text-left text-sm text-sol-text transition-colors hover:bg-sol-bg-highlight"
            >
              {starter.label}
            </button>
          ))}
        </div>
      )}
      {onAsk && hold && <p role="status" className="mt-2 flex max-w-sm justify-center text-sm"><AskHeldLine hold={hold} /></p>}
      {onAsk && !hold && (
        <div className="mt-2 flex w-full max-w-md flex-col gap-1.5" role="list" aria-label="Things to ask">
          {asks.map((ask) => (
            <button
              key={ask}
              type="button"
              role="listitem"
              onClick={() => onAsk(ask)}
              className="group flex items-center justify-between gap-3 rounded-lg border border-sol-border bg-sol-card px-3.5 py-2.5 text-left text-sm text-sol-text transition-colors hover:border-sol-text-dim/60"
            >
              <span>{ask}</span>
              <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-sol-text-dim transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      )}
      {children}
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
