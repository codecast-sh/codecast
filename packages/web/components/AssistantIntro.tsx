// What the hosted assistant does, said where a person starts with it: the
// compose popup's empty state (HostedComposeIntro in sessionControls) and an
// empty inbox in hosted mode (EmptyState). Mail and calendar are named only
// once Whisk is connected; until then a quiet link starts the connect, where
// this deployment can make one (connectionControls, the same rule the lane's
// Connections page reads), which comes back to `returnTo`: the inbox, where
// the shell says how it went (ConnectToast). Each starter (LANE_COPY.home.starters) hands its
// request to `onStarter`, which fills a composer for the person to finish or
// send.
import type { ReactNode } from "react";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { useLaneMail } from "./simple/useLaneMail";
import { LANE_COPY, connectionControls } from "./simple/lane";
import type { WhiskReturnPath } from "@codecast/convex/convex/whisk";
import { AgentTypeIcon } from "./AgentTypeIcon";

export function AssistantIntro({ onStarter, returnTo = "/inbox", children }: { onStarter?: (text: string) => void; returnTo?: WhiskReturnPath; children?: ReactNode }) {
  const mail = useLaneMail(returnTo);
  const { connect } = connectionControls(mail, false);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <AgentTypeIcon agentType={HOSTED_AGENT_TYPE} className="h-8 w-8" />
      <p className="text-lg font-medium text-sol-text">{LANE_COPY.intro.title}</p>
      <p className="max-w-sm text-sm text-sol-text-muted">{LANE_COPY.intro.lede(mail.connected)}</p>
      {onStarter && (
        <div className="mt-1 flex max-w-md flex-wrap justify-center gap-2">
          {LANE_COPY.home.starters(mail.connected).map((starter) => (
            <button
              key={starter.label}
              type="button"
              onClick={() => onStarter(starter.text)}
              className="rounded-full border border-sol-border px-3 py-1 text-xs text-sol-text-muted transition-colors hover:border-sol-cyan hover:text-sol-text"
            >
              {starter.label}
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
          className="text-xs text-sol-cyan hover:underline disabled:opacity-60"
        >
          {LANE_COPY.connections.connect}
        </button>
      )}
    </div>
  );
}
