// Whether a NEW ask to the hosted assistant can run right now, read once for
// every way in (the palette's Ask row, the inbox's first asks and composer,
// the context composer), so none of them creates a conversation that can
// only end in a budget or "trouble thinking" notice. While held, the entry
// keeps the person's words and says why in the same sentence the notice
// would (LANE_COPY.plan.allowanceOut, THINKING_DOWN), with the top-up offer
// where the month ran out.
import { TopUpLink } from "../plan/TopUpLink";
import { THINKING_DOWN, useThinkingAvailable } from "./assistantPromise";
import { useAllowanceOut } from "./usePlanFigures";

export type HostedAskHold = { words: string; allowance: boolean };

/** Why a new ask is held, or null while one can run. Only a said no holds:
 *  a used-up month the wallet reports, or thinking the deployment says is
 *  down; a slow answer to either holds nothing. */
export function useHostedAskGate(enabled = true): HostedAskHold | null {
  const allowance = useAllowanceOut(enabled);
  const down = useThinkingAvailable() === false;
  if (!enabled) return null;
  if (allowance) return { words: allowance, allowance: true };
  return down ? { words: THINKING_DOWN, allowance: false } : null;
}

/** The held sentence, with extra credit offered when the month ran out, so
 *  the line is never a dead end of weeks. */
export function AskHeldLine({ hold, className }: { hold: HostedAskHold; className?: string }) {
  return (
    // Wraps rather than truncates: the reset date and the top-up are what
    // make a held ask not a dead end, so neither may be cut.
    <span data-cc-ask-held className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sol-text-muted ${className ?? ""}`}>
      <span className="min-w-0">{hold.words}</span>
      {hold.allowance && <TopUpLink />}
    </span>
  );
}
