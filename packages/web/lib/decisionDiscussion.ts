// A decision's discussion as a surface draws it (convex decisionDiscussion.ts):
// the server's asks with the owner's replies, then the person's words still
// on their way (the store's local echoes), each once. Pure, so every
// decision surface reads the same thread.
import type { DecisionDiscussionItem, DecisionDiscussionSend } from "../store/inboxStore";

export type DiscussionEntryState = "sending" | "delivering" | "waiting" | "answered";

export type DiscussionEntry = {
  client_id: string;
  text: string;
  by: string | null;
  at: number;
  state: DiscussionEntryState;
  reply: { text: string; at: number } | null;
};

export function discussionThread(row: DecisionDiscussionItem | undefined, sends: readonly DecisionDiscussionSend[] | undefined): DiscussionEntry[] {
  const turns = row?.turns ?? [];
  const known = new Set(turns.map((t) => t.client_id));
  const out: DiscussionEntry[] = turns.map((t) => ({
    client_id: t.client_id,
    text: t.text,
    by: t.by,
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
export function ownerReason(via: NonNullable<DecisionDiscussionItem["owner"]>["via"]): string {
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
