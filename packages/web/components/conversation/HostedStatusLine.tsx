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
import { useUpgradesOpen } from "../simple/billing";
import { THINKING_DOWN, useThinkingAvailable } from "../simple/assistantPromise";
import { WorkingStatusLineView } from "./sessionChrome";
import { TopUpLink } from "../plan/TopUpLink";
import { lastNoticeKind } from "../../lib/hostedNotice";
import { connectionChipCopy, useAppOffline } from "../../hooks/useAppOffline";

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
  // The pitch names a plan only while one can be bought.
  const upgradesOpen = useUpgradesOpen();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Dot className="bg-sol-yellow/70 animate-pulse" />
      <span className="truncate">{busy ? `Finishing “${busy}” first, then this` : "Waiting for your other request to finish"}</span>
      {plan.id === "free" && upgradesOpen && (
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

/** A used-up month: when it comes back, and extra credit when it can be
 *  bought, so the line is never a dead end of weeks. */
function AllowanceOutLine({ words }: { words: string }) {
  return (
    <span data-cc-allowance-out className="flex min-w-0 items-center gap-2 text-sol-text-muted">
      <span className="truncate">{words}</span>
      <TopUpLink />
    </span>
  );
}

export function HostedStatusLine({ conversationId, agentStatus, startedAt, phrase, asking, sending, allowanceOut }: {
  conversationId: string;
  agentStatus?: string;
  startedAt?: number;
  /** The step in flight, in the assistant's words (deriveHostedRunningPhrase). */
  phrase?: string;
  /** The step waiting on the person's go-ahead, in the same words. */
  asking?: string;
  /** A message of the person's is on its way to the engine. */
  sending: boolean;
  /** The month's allowance is used up (useAllowanceOut): said at rest, while
   *  the composer holds Send. */
  allowanceOut?: string | null;
}) {
  const thinking = useThinkingAvailable();
  // A transcript that ends on a stop notice is settled, whatever the work
  // state says: the engine writes the notice first and the state after it,
  // so for a moment the two disagree. The notice says what happened.
  const stopped = useInboxStore((s) => lastNoticeKind(s.messages[conversationId]) !== null);
  // The same link state the developer header's sync chip shows. Hosted mode
  // hides that chip, so a dropped link is said here instead of reading as a
  // slow assistant.
  const connection = connectionChipCopy(useAppOffline());
  if (connection) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sol-text-muted">
        <Dot className="bg-sol-yellow/70 animate-pulse" />
        <span className="truncate">{sending ? "Reconnecting… your message will go as soon as we're back" : connection.label === "Offline" ? "You're offline" : "Reconnecting…"}</span>
      </span>
    );
  }
  if (stopped && !sending) return allowanceOut ? <AllowanceOutLine words={allowanceOut} /> : " ";
  if (agentStatus === "working" || agentStatus === "thinking") return <HostedWorkingLine startedAt={startedAt} phrase={phrase} />;
  if (agentStatus === "waiting") return <WaitingLine conversationId={conversationId} />;
  if (agentStatus === "permission_blocked") {
    // The card may sit out of view (folded to a pill, or behind a scrolled
    // transcript): the line takes the person to it and onto its first option.
    return (
      <button
        type="button"
        onClick={() => focusDecisionCard(conversationId)}
        className="flex min-w-0 items-center gap-1.5 text-sol-orange hover:underline underline-offset-2"
      >
        <Dot className="bg-sol-orange" />
        <span className="truncate">{asking ?? "Waiting for your go-ahead"}</span>
      </button>
    );
  }
  if (sending) {
    return (
      <span className="flex items-center gap-1.5">
        <Dot className="bg-sol-cyan/50 animate-pulse" />
        Getting started…
      </span>
    );
  }
  if (allowanceOut) return <AllowanceOutLine words={allowanceOut} />;
  if (thinking === false) return <span className="truncate text-sol-text-muted">{THINKING_DOWN}</span>;
  return " ";
}

/** Brings a conversation's approval card into view and focuses its first
 *  option, or the card itself when it is folded to a pill. */
function focusDecisionCard(conversationId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-session-decision="${CSS.escape(conversationId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  (card.querySelector<HTMLElement>("[data-option]") ?? card.querySelector<HTMLElement>("button") ?? card).focus({ preventScroll: true });
}

