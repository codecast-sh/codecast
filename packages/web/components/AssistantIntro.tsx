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
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { useLaneMail } from "./simple/useLaneMail";
import { LANE_COPY, connectionControls, firstAsks, plainConnectError } from "./simple/lane";
import { THINKING_DOWN, useThinkingAvailable } from "./simple/assistantPromise";
import type { WhiskReturnPath } from "@codecast/convex/convex/whisk";
import { AgentTypeIcon } from "./AgentTypeIcon";
import { useInboxStore } from "../store/inboxStore";

/** Starters stop being offered once the person has this many conversations
 *  with the assistant: by then they know what to ask. */
const STARTERS_UNTIL = 3;

function useNewToAssistant(): boolean {
  return useInboxStore((s) => {
    let seen = 0;
    for (const row of Object.values(s.sessions)) {
      if (isHostedAgentType(row?.agent_type) && ++seen >= STARTERS_UNTIL) return false;
    }
    return true;
  });
}

export function AssistantIntro({ onStarter, onAsk, returnTo = "/inbox", children }: {
  onStarter?: (text: string) => void;
  onAsk?: (text: string) => void;
  returnTo?: WhiskReturnPath;
  children?: ReactNode;
}) {
  const mail = useLaneMail(returnTo);
  const { connect } = connectionControls(mail, false);
  const newToAssistant = useNewToAssistant();
  const { lead, more } = firstAsks(mail.connected ? mail.can : null);
  const asks = lead ? [lead, ...more] : more;
  // Asks unless the deployment says it cannot think (as on /welcome); a
  // known outage says so instead of offering asks that fail.
  const down = useThinkingAvailable() === false;
  const connectError = plainConnectError(mail.actions.error);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <AgentTypeIcon agentType={HOSTED_AGENT_TYPE} className="h-8 w-8" />
      <p data-cc-intro-title className="text-lg font-medium text-sol-text">{LANE_COPY.intro.title}</p>
      <p className="max-w-sm text-sm text-sol-text-muted">{LANE_COPY.intro.lede(mail.connected)}</p>
      {onStarter && newToAssistant && (
        <div className="mt-1 flex max-w-md flex-wrap justify-center gap-2">
          {LANE_COPY.home.starters(mail.connected).map((starter) => (
            <button
              key={starter.label}
              type="button"
              onClick={() => onStarter(starter.text)}
              className="rounded-full border border-sol-border px-3 py-1 text-xs text-sol-text-muted transition-colors hover:border-sol-text-dim hover:text-sol-text"
            >
              {starter.label}
            </button>
          ))}
        </div>
      )}
      {onAsk && down && <p role="status" className="mt-2 max-w-sm text-sm text-sol-text-muted">{THINKING_DOWN}</p>}
      {onAsk && !down && (
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
