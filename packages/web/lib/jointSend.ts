// "Send together": when someone else in a session's composer has a draft at
// the moment you send, one action sends both as one turn whose parts name
// each author (shared/contracts/jointMessage), so the agent reads one
// instruction instead of two that may contradict.
//
// The composer's own send path stays the only send path. The presence strip
// publishes who is writing what (setJointCandidates); the send chord or the
// strip's button arms a joint send; MessageInput's submit takes it
// (takeJointSend) and folds the parts into the text it was about to send, so
// images, quotes, mention expansion and the pending row all work as for any
// send. Whoever armed it learns what went out (onJointSent) and writes the
// claims that clear each named author's composer.
import { formatJointMessage, type JointPart } from "@codecast/shared/contracts/jointMessage";
import type { PresenceRow } from "../hooks/useDocPresence";

export type JointCandidate = { user_id: string; from: string; text: string };
type Entry = { me: string; candidates: JointCandidate[]; armed: boolean; onSent?: (sent: JointCandidate[]) => void };

const entries = new Map<string, Entry>();

/** Others' live drafts in this session's composer, as the presence strip sees them. */
export function jointCandidatesOf(rows: readonly PresenceRow[]): JointCandidate[] {
  return rows
    .filter((r) => r.draft_text && r.draft_text.trim())
    .map((r) => ({ user_id: r.user_id, from: r.user_name, text: r.draft_text!.trim() }));
}

export function setJointCandidates(conversationId: string, me: string, candidates: JointCandidate[], onSent: (sent: JointCandidate[]) => void): void {
  if (candidates.length === 0) { entries.delete(conversationId); return; }
  const prev = entries.get(conversationId);
  entries.set(conversationId, { me, candidates, armed: prev?.armed ?? false, onSent });
}

export function jointSendReady(conversationId: string): boolean {
  return (entries.get(conversationId)?.candidates.length ?? 0) > 0;
}

/** Arm the next submit of this session's composer to go out as one joint turn. */
export function armJointSend(conversationId: string): boolean {
  const entry = entries.get(conversationId);
  if (!entry?.candidates.length) return false;
  entry.armed = true;
  return true;
}

/** The pure fold: my words first, then each other person's draft, each under its author. */
export function composeJointTurn(me: string, mine: string, candidates: readonly JointCandidate[]): string {
  const parts: JointPart[] = [{ from: me, body: mine }, ...candidates.map((c) => ({ from: c.from, body: c.text }))];
  return formatJointMessage(parts);
}

/**
 * Called by the composer's submit with the text it is about to send. When a
 * joint send is armed, returns the joint turn (and tells the armer what went
 * out); otherwise returns the text unchanged.
 */
export function takeJointSend(conversationId: string, mine: string): string {
  const entry = entries.get(conversationId);
  if (!entry?.armed) return mine;
  entry.armed = false;
  entry.onSent?.(entry.candidates);
  return composeJointTurn(entry.me, mine, entry.candidates);
}

/**
 * What a claim leaves of my draft: the words after the claimed text when my
 * draft still begins with it (I kept typing), nothing when it is the claimed
 * text, and null when my draft no longer holds it (I rewrote it, so it stays).
 */
export function draftAfterClaim(draft: string, claimed: string): string | null {
  const d = draft.trim();
  const c = claimed.trim();
  if (!c || !d.startsWith(c)) return null;
  return d.slice(c.length).trim();
}
