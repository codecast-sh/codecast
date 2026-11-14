// When a waiting message offers the live terminal on its own: it is stuck on
// something the transcript cannot show. Two shapes:
//   held   the daemon held the send for the pane (a trust prompt, a /model
//          picker, a screen it could not answer, a signed-out agent)
//   stuck  the send has sat undelivered on a live session past STUCK_AFTER_MS
//          with no hold while the agent is not producing, so the pane shows
//          something nothing parses (a queued send behind a long turn is
//          ordinary and offers nothing)
// Pure, so the rule is tested without React Native.

export const STUCK_AFTER_MS = 45_000;

/** A machine unheard from this long is asleep or offline: its pane cannot answer, so a waiting send offers nothing. */
export const MACHINE_QUIET_MS = 3 * 60_000;

// The daemon's own words for a hold that only the pane can clear
// (InputBlockedError in cli/src/daemon.ts): a dialog, or a signed-out agent.
const PANE_HOLD = /in the terminal|signed out on this machine/;

export function isPaneHold(reason: string | null | undefined): boolean {
  return !!reason && PANE_HOLD.test(reason);
}

export type TerminalOffer = 'held' | 'stuck';

export function terminalOffer(input: {
  /** The pane exists and this person may drive it. */
  reachable: boolean;
  isLive: boolean;
  /** The agent is mid-turn (working, thinking, compacting): a queue is expected. */
  agentBusy: boolean;
  /** Why the daemon holds this message, when it does. */
  holdReason: string | null | undefined;
  /** When the message was sent, while it is still undelivered; null once it landed. */
  pendingSince: number | null;
  now: number;
}): TerminalOffer | null {
  if (!input.reachable) return null;
  if (isPaneHold(input.holdReason)) return 'held';
  if (input.holdReason || !input.isLive || input.agentBusy || input.pendingSince === null) return null;
  return input.now - input.pendingSince > STUCK_AFTER_MS ? 'stuck' : null;
}

export interface PendingRowLike {
  status?: string;
  hold_reason?: string | null;
  created_at?: number;
  /** Parked on purpose until the turn ends: waiting is its job. */
  queued?: boolean;
}

/** The server's pending view of a conversation (getConversationPendingMessage): a primary row plus every undelivered one. */
export interface PendingLike extends PendingRowLike {
  inflight?: PendingRowLike[];
}

const UNDELIVERED = new Set(['pending', 'injected']);

/**
 * The session-wide offer, read from the server's pending rows rather than from
 * a transcript bubble: a held message's bubble can render late or be replaced
 * by a prompt card while the hold stands, and the offer must not go with it.
 * `nextAt` is when a waiting send would turn into a `stuck` offer, so the
 * screen can re-render once at that moment.
 */
export function sessionTerminalOffer(input: {
  reachable: boolean;
  isLive: boolean;
  agentBusy: boolean;
  pending: PendingLike | null | undefined;
  now: number;
}): { offer: TerminalOffer | null; nextAt: number | null } {
  if (!input.reachable || !input.pending) return { offer: null, nextAt: null };
  const rows = [input.pending, ...(input.pending.inflight ?? [])].filter((r) => !!r.status && UNDELIVERED.has(r.status));
  let nextAt: number | null = null;
  let stuck = false;
  for (const r of rows) {
    if (r.queued && !isPaneHold(r.hold_reason)) continue;
    const offer = terminalOffer({
      reachable: true,
      isLive: input.isLive,
      agentBusy: input.agentBusy,
      holdReason: r.status === 'pending' ? r.hold_reason : null,
      pendingSince: r.created_at ?? null,
      now: input.now,
    });
    if (offer === 'held') return { offer, nextAt: null };
    if (offer === 'stuck') stuck = true;
    else if (!r.hold_reason && typeof r.created_at === 'number') {
      const at = r.created_at + STUCK_AFTER_MS + 1;
      if (at > input.now) nextAt = nextAt === null ? at : Math.min(nextAt, at);
    }
  }
  return { offer: stuck ? 'stuck' : null, nextAt: stuck ? null : nextAt };
}
