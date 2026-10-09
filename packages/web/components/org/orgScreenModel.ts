// The Org screen's pure helpers (essence spec §3.2, §5): the URL, the panel's
// size, which conversation a proposal opens in, the message a proposal's card
// sits in, and which proposals to feed. No React, so the rules test without a
// DOM.
import type { Layout } from "react-resizable-panels";
import { composeParam, openProposals, proposalParam } from "./staffingModel";
import type { OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import type { ClientLayouts } from "../../store/clientPrefsTypes";

/** A host's scroll-to request for an embedded conversation: the message to
 *  land on, or the time to centre on while the message is not loaded, with
 *  `find` naming the proposal whose card the embed then looks for in the
 *  window that lands (findProposalCardMessage). A new nonce is a new request.
 *  `onSettled` runs once the thread has settled on the message's row, once
 *  per nonce: the host then lands on what it wanted inside that row (a card,
 *  the focused entry), and the thread's own settle yields to that scroll. */
export type JumpRequest = { messageId?: string; timestamp?: number; find?: string; nonce: number; onSettled?: () => void };

export type OrgScreenParams = {
  /** `op-N`, lower case: the proposal the panel holds. */
  proposal: string | null;
  /** The change seq to light. */
  focus: number | null;
  /** The conversation the panel holds. */
  session: string | null;
  /** Text to seed the Head of People's draft with. */
  compose: string | null;
  /** `panel=history`: open the history sheet. */
  history: boolean;
};

const paramsOf = (search: string | URLSearchParams | null | undefined): URLSearchParams =>
  typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search ?? new URLSearchParams();

/** Every URL parameter the screen reads, from one parse. */
export function orgScreenParams(search: string | URLSearchParams | null | undefined): OrgScreenParams {
  const q = paramsOf(search);
  const s = q.toString();
  const focus = q.get("focus");
  return {
    proposal: proposalParam(s),
    focus: focus && /^\d+$/.test(focus) ? Number(focus) : null,
    session: q.get("session")?.trim() || null,
    compose: composeParam(s),
    history: q.get("panel") === "history",
  };
}

/** Where the retired health page's address lands: `/org?view=health` is the
 *  Org screen, every other parameter kept. Null for any other address, so the
 *  route renders the screen as it is. */
export function healthRedirect(search: string | URLSearchParams | null | undefined): string | null {
  const q = paramsOf(search);
  if (q.get("view") !== "health") return null;
  q.delete("view");
  const s = q.toString();
  return s ? `/org?${s}` : "/org";
}

// -------- the panel beside the canvas

/** Under this screen width an open panel takes the whole content area. */
export const ORG_PANEL_FILLS_BELOW = 900;
/** The panel's first width and its double-click reset, in percent. */
export const ORG_DETAIL_DEFAULT = 44;
export const ORG_DETAIL_MIN_PX = 380;
/** What the panel always leaves the canvas. */
export const ORG_CANVAS_MIN_PX = 420;
export const ORG_CANVAS_ID = "org-canvas";
export const ORG_DETAIL_ID = "org-detail";

/** A stored size counts only when it leaves both sides room. */
export function detailSizeOf(stored: ClientLayouts["org_detail"] | undefined): number {
  const d = stored?.detail;
  return typeof d === "number" && d >= 5 && d <= 95 ? d : ORG_DETAIL_DEFAULT;
}

/** The Group's layout: closed, the canvas alone; open, the person's size;
 *  filling (a narrow screen), the panel alone. */
export function detailLayout(open: boolean, fills: boolean, detail: number): Layout {
  if (!open) return { [ORG_CANVAS_ID]: 100, [ORG_DETAIL_ID]: 0 };
  if (fills) return { [ORG_CANVAS_ID]: 0, [ORG_DETAIL_ID]: 100 };
  return { [ORG_CANVAS_ID]: 100 - detail, [ORG_DETAIL_ID]: detail };
}

// -------- proposals

/** Where a proposal opens (§3.2): its own thread, scrolled to the card; for a
 *  row from before `thread` existed, the author's conversation; for one a
 *  person posted (`thread: null`), the card alone. */
export type ProposalPanel = { kind: "thread"; conversationId: string } | { kind: "card" };

export function proposalPanelOf(p: Pick<OrgProposalRow, "thread" | "author">, tree: Pick<OrgTree, "roles"> | null): ProposalPanel {
  if (p.thread) return { kind: "thread", conversationId: p.thread.conversation_id };
  if (p.thread === null) return { kind: "card" };
  const a = p.author;
  if (a.kind === "session" && a.id) return { kind: "thread", conversationId: a.id };
  if (a.kind === "role") {
    const role = tree?.roles.find((r) => r._id === a.id || (!!a.handle && r.handle === a.handle) || (!!a.short_id && r.short_id === a.short_id));
    const conv = role?.standing?.conversation_id;
    if (conv) return { kind: "thread", conversationId: String(conv) };
  }
  return { kind: "card" };
}

/** The message that draws a proposal's card: the first one from the START
 *  whose text has `op-N` alone on a line (the same line CARD_RE in
 *  orgChartPointer.ts reads, which also takes `#seq`) and that a person did
 *  not write. The author posts the card once; later turns write `op-N#3` in
 *  sentences and the person's reply block writes `op-N#seq` followed by
 *  words, so neither matches. */
export function findProposalCardMessage(messages: readonly { _id: string; role?: string; content?: string }[] | undefined, shortId: string): string | null {
  const re = new RegExp(`^[ \\t]*${shortId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "im");
  return messages?.find((m) => m.role !== "user" && typeof m.content === "string" && re.test(m.content))?._id ?? null;
}

/** The change rows of this many open proposals are fed at once (one
 *  subscription each, OrgProposalFeeders); real data needs about five. */
export const OPEN_PROPOSAL_FEED_CAP = 8;

/** The refs to feed change rows for: this workspace's open proposals, oldest
 *  first, capped, plus the linked one when it is not among them. */
export function openProposalsToFeed(rows: OrgProposalRow[], linkedRef: string | null): string[] {
  const refs = openProposals(rows).reverse().slice(0, OPEN_PROPOSAL_FEED_CAP).map((p) => p.short_id);
  if (linkedRef && !refs.includes(linkedRef)) refs.push(linkedRef);
  return refs;
}
