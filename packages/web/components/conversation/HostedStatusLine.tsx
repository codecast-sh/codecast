// The composer's status line for a hosted conversation (plan pl-840). It
// reads the turn engine's own work state (the managed row's agent_status,
// written by assistant/turns.ts) and never a daemon's: there is no machine
// to connect to, resume or restart. One wait reads one way ("Thinking…", or
// the step in flight in the assistant's words), waiting names the request it
// waits behind, an approval is said by its card alone, and a stop by the
// notice in the transcript, which carries Try again. While it works, the
// person can Stop it.
import { useEffect, useState } from "react";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useInboxStore } from "../../store/inboxStore";
import { conversationTitle } from "../../lib/conversationTitle";
import { usePlanMeter } from "../simple/usePlanFigures";
import { useUpgradesOpen } from "../simple/billing";
import { THINKING_DOWN, useThinkingAvailable } from "../simple/assistantPromise";
import { AskHeldLine } from "../simple/useHostedAskGate";
import { lastNoticeKind } from "../../lib/hostedNotice";
import { hostedConnectionWords, useHostedConnection } from "./HostedConnection";

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
      <Dot className="bg-sol-text-dim/50 animate-pulse" />
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

/** How long a wait reads as "Thinking…" before it says it is still at it:
 *  a turn can run for minutes, and an unchanging line reads as a hang. */
export const STILL_WORKING_AFTER_MS = 45_000;

/** The one wait line, from a message on its way to the reply: the step in
 *  flight when there is one, else "Thinking…", and past
 *  STILL_WORKING_AFTER_MS "Still working on it…". No stopwatch: a person
 *  waiting on an answer reads a running clock as a slow one. With a
 *  conversation, a quiet Stop ends the turn (store stopHostedTurn). */
function ThinkingLine({ phrase, conversationId }: { phrase?: string; conversationId?: string }) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLong(true), STILL_WORKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Dot className="bg-sol-text-dim/60 animate-pulse" />
      <span className="truncate">{phrase ?? (long ? "Still working on it…" : "Thinking…")}</span>
      {conversationId && (
        <button
          type="button"
          data-cc-hosted-stop
          onClick={() => useInboxStore.getState().stopHostedTurn(conversationId)}
          className="ml-1 shrink-0 text-sol-text-dim underline-offset-2 hover:text-sol-text hover:underline"
        >
          Stop
        </button>
      )}
    </span>
  );
}

/** A used-up month: when it comes back, and extra credit when it can be
 *  bought (the same line every new ask shows while held). */
function AllowanceOutLine({ words }: { words: string }) {
  return <AskHeldLine hold={{ words, allowance: true }} />;
}

/** At rest with the composer focused and empty: Escape hands the keys to
 *  the app (MessageInput), where single keys move around. Said once ever, in
 *  the words a person uses for it: the first showing marks it seen on every
 *  device, and after that the shortcuts sheet (?) carries it. */
function EscapeHint() {
  const seen = useInboxStore((s) => !!s.clientState.ui?.hosted_esc_hint_seen);
  // Shown for this focus, then remembered: the mark lands after the paint, so
  // this showing stays until the composer loses focus or fills.
  const [showing] = useState(() => !seen);
  useMountEffect(() => {
    if (!seen) useInboxStore.getState().updateClientUI({ hosted_esc_hint_seen: true });
  });
  if (!showing) return " ";
  return (
    <span className="ml-auto hidden items-center gap-1 text-sol-text-dim sm:flex">
      <KeyCap size="xs">Esc</KeyCap> for shortcuts
    </span>
  );
}

export function HostedStatusLine({ conversationId, agentStatus, phrase, sending, allowanceOut, escapeHint = false, awaitsOk = false, stopInDisc = false }: {
  conversationId: string;
  agentStatus?: string;
  /** The step in flight, in the assistant's words (deriveHostedRunningPhrase). */
  phrase?: string;
  /** A message of the person's is on its way to the engine. */
  sending: boolean;
  /** The month's allowance is used up (useAllowanceOut): said at rest, while
   *  the composer holds Send. */
  allowanceOut?: string | null;
  /** The composer is focused and empty, so Escape would leave it. */
  escapeHint?: boolean;
  /** A decision row of this conversation is still pending (awaitingOkIds). */
  awaitsOk?: boolean;
  /** The send disc is the Stop square now, so the line says no second Stop. */
  stopInDisc?: boolean;
}) {
  const thinking = useThinkingAvailable();
  // A transcript that ends on a stop notice is settled, whatever the work
  // state says: the engine writes the notice first and the state after it,
  // so for a moment the two disagree. The notice says what happened.
  const stopped = useInboxStore((s) => lastNoticeKind(s.messages[conversationId]) !== null);
  // "Getting started…" is for a conversation's first turn only; a follow-up
  // waits on the same "Thinking…" the run shows, so one wait reads one way.
  const answeredBefore = useInboxStore((s) => (s.messages[conversationId] ?? []).some((m) => m.role === "assistant"));
  // The same link state the developer header's sync chip shows. Hosted mode
  // hides that chip, so a dropped link is said here instead of reading as a
  // slow assistant.
  const connection = useHostedConnection();
  if (connection) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sol-text-muted" title={connection.detail}>
        <Dot className="bg-sol-text-dim/50 animate-pulse" />
        <span className="truncate">{hostedConnectionWords(connection, sending)}</span>
      </span>
    );
  }
  if (stopped && !sending) {
    if (allowanceOut) return <AllowanceOutLine words={allowanceOut} />;
    // The conversation the outage stopped is where its reason belongs.
    return thinking === false ? <span className="truncate text-sol-text-muted">{THINKING_DOWN}</span> : " ";
  }
  if (agentStatus === "working" || agentStatus === "thinking") return <ThinkingLine phrase={phrase} conversationId={stopInDisc ? undefined : conversationId} />;
  if (agentStatus === "waiting") return <WaitingLine conversationId={conversationId} />;
  // The approval card sits at the end of the transcript and the composer's
  // placeholder points at it; a third line saying so would be noise. Once the
  // card is answered the row's status lags while the turn wraps up, and the
  // rail already says Working on it, so the pane says so too.
  if (agentStatus === "permission_blocked") return awaitsOk ? " " : <ThinkingLine phrase={phrase} />;
  if (sending) {
    return answeredBefore ? <ThinkingLine /> : (
      <span className="flex items-center gap-1.5">
        <Dot className="bg-sol-text-dim/60 animate-pulse" />
        Getting started…
      </span>
    );
  }
  if (allowanceOut) return <AllowanceOutLine words={allowanceOut} />;
  if (thinking === false) return <span className="truncate text-sol-text-muted">{THINKING_DOWN}</span>;
  return escapeHint ? <EscapeHint /> : " ";
}
