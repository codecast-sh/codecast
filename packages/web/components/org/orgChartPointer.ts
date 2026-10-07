// The pointer a thread carries toward the org screen (docs/architecture/
// org-staffing.md S36, S41): which proposal, what is in focus, which lens.
// Pure. What the agent writes to move the map beside its conversation is
// message text it already writes: `op-N` on its own line, or a link to the
// org page. orgScreenModel.orgScreenPath builds the address itself.
import { parseAboutChange } from "@codecast/shared/contracts/orgProposal";

/** The map's filters (org-staffing.md S40): everything, the goals alone, or the reporting chart. */
export type ChartLens = "everything" | "people" | "goals";
/** What the map shows: a proposal's ghosts, one thing in focus, a lens, and
 *  whether the proposal is overlaid ("As proposed"; absent means it is). */
export type ChartPointer = { proposal?: string; focus?: string; lens?: ChartLens; proposed?: boolean };

const lensOf = (v: string | null | undefined): ChartLens | undefined => (v === "goals" || v === "people" || v === "everything" ? v : undefined);
const proposalOf = (v: string | null | undefined): string | undefined => (v && /^op-\d+$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined);

/** The pointer an address carries. */
export function chartPointerOfParams(q: URLSearchParams): ChartPointer {
  const proposal = proposalOf(q.get("proposal"));
  const focus = q.get("focus")?.trim() || undefined;
  const lens = lensOf(q.get("lens"));
  const proposed = q.get("proposed") === "0" ? false : undefined;
  return { ...(proposal ? { proposal } : {}), ...(focus ? { focus } : {}), ...(lens ? { lens } : {}), ...(proposed === false ? { proposed } : {}) };
}

const LINK_RE = /\/org\?([^\s)\]>"'`]+)/g;
/** `op-7` or `op-7#3` alone on a line: the proposal, and the change in focus. */
const CARD_RE = /^[ \t]*(op-\d+)(?:#(\d+))?[ \t]*$/gim;

/**
 * The LAST pointer a message's text carries, null when it carries none:
 * - a link to the org page that names a proposal (`/org?proposal=op-7&focus=3`),
 * - `op-7` on its own line (the line that draws the proposal card), or
 *   `op-7#3` on its own line (the line that draws one change's card): that change,
 * - a person's "About op-7 change 3" header (the card's Ask): that change.
 */
export function chartPointerOfText(text: string | null | undefined): ChartPointer | null {
  if (!text || text.indexOf("op-") < 0) return null;
  const about = parseAboutChange(text);
  let best: { at: number; pointer: ChartPointer } | null = about ? { at: 0, pointer: { proposal: about.proposal.toLowerCase(), focus: String(about.seq) } } : null;
  for (const m of text.matchAll(LINK_RE)) {
    const pointer = chartPointerOfParams(new URLSearchParams(m[1].replace(/&amp;/g, "&").replace(/[.,;:!?]+$/, "")));
    if (pointer.proposal && (!best || m.index! >= best.at)) best = { at: m.index!, pointer };
  }
  for (const m of text.matchAll(CARD_RE)) {
    if (!best || m.index! > best.at) best = { at: m.index!, pointer: { proposal: m[1].toLowerCase(), ...(m[2] ? { focus: m[2] } : {}) } };
  }
  return best?.pointer ?? null;
}

export type ThreadPointer = ChartPointer & { /** The message that carries it plus what it says: a new key is a new pointer. */ key: string };

/** The newest pointer in a thread, scanning from its end. */
export function newestChartPointer(messages: readonly { _id: string; content?: string }[] | null | undefined): ThreadPointer | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i];
    const pointer = chartPointerOfText(m.content);
    if (pointer) return { ...pointer, key: `${m._id}|${pointer.proposal ?? ""}|${pointer.focus ?? ""}|${pointer.lens ?? ""}` };
  }
  return null;
}
