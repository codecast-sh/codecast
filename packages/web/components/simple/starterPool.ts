// What the assistant offers to start with, read once for the web and the
// phone: the compose sheet's starters and the home's whole asks. Both draw
// from one pool (/welcome's firstAsks, then a few more), less any a
// conversation already began with, so the sheet and the home never drift and
// day two does not look like day one. Someone new gets starters that ask them
// for the details; someone back gets whole asks, a routine among them.
import { isHostedAgentType } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { LANE_COPY, firstAsks, type MailAbilities } from "./lane";
import { ASKS } from "./assistantPromise";

/** Starters stop being offered once the person has this many conversations
 *  with the assistant: by then they know what to ask. */
const STARTERS_UNTIL = 3;
/** How many starters the compose sheet, and the home of someone new, offer. */
export const SHEET_STARTERS = 3;
/** The home of someone back leads with what is theirs; this many asks follow. */
export const RETURNING_ASKS = 2;

export type Starter = { label: string; text: string };

export function useNewToAssistant(): boolean {
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

/** Whole asks from the one pool, in order, that no conversation began with. */
function unaskedAsks(firstOnes: readonly string[]): string[] {
  return [...new Set([...firstOnes, ASKS.mondays, ASKS.sayNo, ASKS.compare, ASKS.trip])].filter((ask) => !askedBefore(ask));
}

/** The pool for someone whose mail can do `can` (null when not connected):
 *  the whole asks the home sends, and the compose sheet's starters (up to
 *  SHEET_STARTERS the person has not asked yet; someone back draws from the
 *  whole-ask pool, so the sheet keeps offering a few). */
export function useStarterPool(connected: boolean, can: MailAbilities | null): { newToAssistant: boolean; asks: string[]; starters: Starter[] } {
  const newToAssistant = useNewToAssistant();
  const { lead, more } = firstAsks(connected ? can : null);
  const pool = unaskedAsks(lead ? [lead, ...more] : more);
  const asks = pool.slice(0, newToAssistant ? SHEET_STARTERS : RETURNING_ASKS);
  const starters = (newToAssistant
    ? LANE_COPY.home.starters(connected).filter((starter) => !askedBefore(starter.text))
    : pool.map((ask) => ({ label: ask, text: ask })))
    .slice(0, SHEET_STARTERS);
  return { newToAssistant, asks, starters };
}
