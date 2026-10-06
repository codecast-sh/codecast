// The composer's status line for a hosted conversation (plan pl-840). It
// reads the turn engine's own work state (the managed row's agent_status,
// written by assistant/turns.ts) and never a daemon's: there is no machine
// to connect to, resume or restart. Working names the step in flight in the
// assistant's words, waiting names the request it waits behind, and a stop
// is said by the notice in the transcript, which carries Try again.
import { useState } from "react";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useInboxStore } from "../../store/inboxStore";
import { conversationTitle } from "../../lib/conversationTitle";
import { usePlanMeter } from "../simple/usePlanFigures";
import { WorkingStatusLineView } from "./sessionChrome";

/** The title of the person's other hosted conversation that is running now,
 *  the one a waiting request waits behind. */
function useBusyElsewhere(conversationId: string): string | null {
  return useInboxStore((s) => {
    for (const [id, row] of Object.entries(s.sessions)) {
      if (id === conversationId || !isHostedAgentType(row?.agent_type)) continue;
      if (row?.agent_status === "working" || row?.agent_status === "thinking") return conversationTitle(row);
    }
    return null;
  });
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${className}`} />;
}

function WaitingLine({ conversationId }: { conversationId: string }) {
  const busy = useBusyElsewhere(conversationId);
  // The wallet is fed elsewhere (the sidebar meter in the sync host); this
  // reads what the store holds.
  const { plan } = usePlanMeter(false);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Dot className="bg-sol-yellow/70 animate-pulse" />
      <span className="truncate">{busy ? `Finishing “${busy}” first, then this` : "Waiting for your other request to finish"}</span>
      {plan.id === "free" && (
        <button
          type="button"
          onClick={() => useInboxStore.getState().openSettingsModal("plan")}
          className="shrink-0 text-sol-text-dim/70 underline-offset-2 hover:text-sol-text hover:underline"
        >
          · Plus does two at once
        </button>
      )}
    </span>
  );
}

function HostedWorkingLine({ startedAt, phrase }: { startedAt?: number; phrase?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  });
  return <WorkingStatusLineView startedAt={startedAt} now={now} label={phrase} labelNow />;
}

export function HostedStatusLine({ conversationId, agentStatus, startedAt, phrase, asking, sending }: {
  conversationId: string;
  agentStatus?: string;
  startedAt?: number;
  /** The step in flight, in the assistant's words (deriveHostedRunningPhrase). */
  phrase?: string;
  /** The step waiting on the person's go-ahead, in the same words. */
  asking?: string;
  /** A message of the person's is on its way to the engine. */
  sending: boolean;
}) {
  if (agentStatus === "working" || agentStatus === "thinking") return <HostedWorkingLine startedAt={startedAt} phrase={phrase} />;
  if (agentStatus === "waiting") return <WaitingLine conversationId={conversationId} />;
  if (agentStatus === "permission_blocked") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sol-orange">
        <Dot className="bg-sol-orange" />
        <span className="truncate">{asking ?? "Waiting for your go-ahead"}</span>
      </span>
    );
  }
  if (sending) {
    return (
      <span className="flex items-center gap-1.5">
        <Dot className="bg-sol-cyan/50 animate-pulse" />
        Getting started...
      </span>
    );
  }
  return " ";
}
