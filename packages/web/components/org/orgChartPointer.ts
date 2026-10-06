// The chart beside a conversation (docs/architecture/org-staffing.md S36):
// its address, and the pointer a thread carries. Pure. The pane's whole state
// is its URL, and what the agent writes to move it is message text it already
// writes: `op-N` on its own line, or a link to the chart.
import { ORG_GOAL_KINDS, parseAboutChange, type OrgChangeKind } from "@codecast/shared/contracts/orgProposal";
import { roleNodeId } from "./orgLayout";
import { goalNodeId } from "./goalsLayout";

/** The map's filters (org-staffing.md S40): everything, the goals alone, or the reporting chart. */
export type ChartLens = "everything" | "people" | "goals";
/** What a pane shows: a proposal's ghosts, one thing in focus, a lens, and
 *  whether the proposal is overlaid ("As proposed"; absent means it is). */
export type ChartPointer = { proposal?: string; focus?: string; lens?: ChartLens; proposed?: boolean };

const lensOf = (v: string | null | undefined): ChartLens | undefined => (v === "goals" || v === "people" || v === "everything" ? v : undefined);
const proposalOf = (v: string | null | undefined): string | undefined => (v && /^op-\d+$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined);

/** `/org?view=chart&...`: the chart alone. `session` is the conversation it follows. */
export function orgChartPath(p: ChartPointer & { session?: string | null; follow?: boolean; /** The dev preview's fixture org (staffingModel.orgPreviewEnabled). */ preview?: boolean }): string {
  const q = new URLSearchParams({ view: "chart" });
  if (p.proposal) q.set("proposal", p.proposal);
  if (p.focus) q.set("focus", p.focus);
  if (p.lens) q.set("lens", p.lens);
  if (p.proposed === false) q.set("proposed", "0");
  if (p.session) q.set("s", p.session);
  if (p.follow === false) q.set("follow", "0");
  if (p.preview) q.set("preview", "1");
  return `/org?${q.toString()}`;
}

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

// ---------------------------------------------------------------- what a pointer shows


type ViewChange = { _id: string; seq: number; status: string; change: { kind: OrgChangeKind } };
export type ChartView = { lens: ChartLens; focus: { kind: "change" | "node"; id: string } | null };

/**
 * A pointer read against what is in hand: which lens, and what to pan to.
 * `focus` is a change by its number in the proposal, a goal by `in-N`, or a
 * role by `@handle`. With no lens named the map shows everything, where any
 * focus has a place; a named lens holds.
 */
export function chartView(pointer: ChartPointer, ctx: {
  changes: readonly ViewChange[];
  initiatives: readonly { _id: string; short_id: string }[];
  roles: readonly { _id: string; handle: string; status: string }[];
}): ChartView {
  const isGoal = (c: ViewChange) => ORG_GOAL_KINDS.includes(c.change.kind);
  const live = ctx.changes.filter((c) => c.status !== "removed");
  const f = pointer.focus?.trim() ?? "";
  let focus: ChartView["focus"] = null;
  if (/^\d+$/.test(f)) {
    const c = live.find((x) => x.seq === Number(f));
    if (c) focus = { kind: "change", id: c._id };
  } else if (/^in-\d+$/i.test(f)) {
    const g = ctx.initiatives.find((x) => x.short_id === f.toLowerCase());
    if (g) focus = { kind: "node", id: goalNodeId(g._id) };
  } else if (f.startsWith("@")) {
    const r = ctx.roles.find((x) => x.status !== "retired" && x.handle.toLowerCase() === f.slice(1).toLowerCase());
    if (r) focus = { kind: "node", id: roleNodeId(r._id) };
  }
  // A named lens holds unless the focus has no place on it: a role is not on the goals outline, a goal is not on the reporting chart.
  let lens: ChartLens = pointer.lens ?? "everything";
  if (focus && lens !== "everything") {
    const goal = focus.kind === "change" ? isGoal(live.find((x) => x._id === focus!.id)!) : focus.id.startsWith("goal:");
    if (goal && lens === "people") lens = "everything";
    if (!goal && lens === "goals") lens = "everything";
  }
  return { lens, focus };
}
