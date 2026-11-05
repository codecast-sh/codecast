"use client";
// The fix for a message held because its session runs in a terminal Codecast
// can't type into (shared/contracts/deliveryHold): restart the session in tmux.
// It ends the person's own agent process, so it goes through the confirm flow.
// The composer footer follows the restart from there.
import { useState } from "react";
import { toast } from "sonner";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { restartInTmuxLedger } from "../../consequential/ledgers";
import { ghostRestartContextFor } from "../../../hooks/useSessionRestart";
import { requestSessionRestart } from "../../../lib/sessionCommands";
import { followRestoredConversation } from "../../../lib/followRestoredConversation";
import { isParkedDispatchError } from "../../../store/mutativeMiddleware";

export function TerminalHoldRestart({ conversationId, terminal, working }: { conversationId: string; terminal: string; working: boolean }) {
  const [state, setState] = useState<"idle" | "review" | "sent">("idle");
  const restart = async () => {
    setState("sent");
    try {
      followRestoredConversation(await requestSessionRestart(conversationId, ghostRestartContextFor(conversationId)), conversationId);
    } catch (err) {
      if (isParkedDispatchError(err)) return;
      setState("idle");
      toast.error(err instanceof Error ? err.message : "Couldn't restart the session");
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setState("review"); }}
        disabled={state === "sent"}
        className="px-2 py-0.5 rounded border border-sol-border text-xs text-sol-text-muted hover:text-sol-text hover:border-sol-text-dim transition-colors disabled:opacity-60"
        data-testid="pending-message-restart-in-tmux"
      >
        {state === "sent" ? "Restarting…" : "Restart in tmux"}
      </button>
      {state === "review" && (
        <SwitchReview ledger={restartInTmuxLedger({ terminal, working })} onClose={() => setState("idle")} onConfirm={() => { void restart(); }} />
      )}
    </>
  );
}
