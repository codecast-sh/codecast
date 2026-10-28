// A conversation with a session through a surface (a line's chat, convex
// lineChat.ts): the server's asks with the session's replies, then the
// person's words still on their way (local echoes), each once. Pure. A
// decision's thread reads its own rows (lib/decisionThread.ts) and shares the
// owner words and the echo settling below.
import type { DecisionThreadItem } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";

export type DiscussionEntryState = "sending" | "delivering" | "waiting" | "answered";

export type DiscussionEntry = {
  client_id: string;
  text: string;
  by: string | null;
  at: number;
  state: DiscussionEntryState;
  reply: { text: string; at: number } | null;
};

/** Words on their way: painted at once, retired when the row carries the same client id. */
type EchoedSend = { client_id: string; text: string; at: number };

/** The asks a surface's row carries: a line's chat. */
type ThreadTurn = { client_id: string; text: string; by?: string | null; at: number; delivered: boolean; reply: { text: string; at: number } | null };

export function discussionThread(row: { turns?: readonly ThreadTurn[] } | undefined, sends: readonly EchoedSend[] | undefined): DiscussionEntry[] {
  const turns = row?.turns ?? [];
  const known = new Set(turns.map((t) => t.client_id));
  const out: DiscussionEntry[] = turns.map((t) => ({
    client_id: t.client_id,
    text: t.text,
    by: t.by ?? null,
    at: t.at,
    state: t.reply ? "answered" : t.delivered ? "waiting" : "delivering",
    reply: t.reply,
  }));
  for (const s of sends ?? []) {
    if (!known.has(s.client_id)) out.push({ client_id: s.client_id, text: s.text, by: null, at: s.at, state: "sending", reply: null });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Why the owner answers for it, in a person's words. */
export function ownerReason(via: NonNullable<DecisionThreadItem["owner"]>["via"]): string {
  switch (via) {
    case "asker": return "It asked this question.";
    case "run": return "It started the run that asks this.";
    case "lead": return "It leads this project, and the session that asked is gone.";
    case "workspace": return "It is the workspace's agent, and nobody else answers for this question.";
  }
}

/** The line under an ask while it has no reply. */
export function waitingWords(state: DiscussionEntryState, owner: string): string | null {
  if (state === "sending") return "Sending…";
  if (state === "delivering") return `On its way to ${owner}`;
  if (state === "waiting") return `${owner} has it and is answering`;
  return null;
}

/** A send painted as a local echo, settled: a refusal (the side effect's
 *  { error }, or a refused dispatch) takes the echo back and resolves with the
 *  reason; anything else resolves null and leaves the echo for the feed to
 *  retire, since the outbox still delivers a parked send. */
export async function settleEchoedSend(sent: Promise<unknown>, dropEcho: () => void): Promise<string | null> {
  let refusal: string | null = null;
  try {
    const res = (await sent) as { error?: unknown } | null | undefined;
    if (res && typeof res.error === "string") refusal = res.error;
  } catch (error) {
    if (!isRefusedDispatchError(error)) return null;
    refusal = error instanceof Error ? error.message : String(error);
  }
  if (refusal) dropEcho();
  return refusal;
}
