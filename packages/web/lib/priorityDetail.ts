// One priority as its page and its reference card draw it, with one home per
// fact. The `priorities` list row (convex priorities.list) is the priority:
// every field it carries is read from it, its rank live from its place
// (withLiveRanks), so the store's own writes (a move, a tier, set aside) paint
// on the card and the page at once. `priorityDetails` (fed from
// priorities.show) holds only what `show` alone returns: the owner's
// corrections, the sessions whose milestone is gone, and links and plan where
// the list row has none (a teammate's or a past priority). A priority the list
// does not hold (another workspace's, a teammate's past the list's cap) keeps
// its row as `base` on the detail row, its only home. Imported by the phone
// too, so it reaches nothing DOM-only.
import type { PriorityCorrection, PriorityDetail, PriorityMilestoneLinks, PriorityPlanRef, PriorityRow, PrioritySession } from "@codecast/shared/contracts/priorities";
import { withLiveRanks } from "./priorities";
import { cachedAt } from "./detailRows";
import { lookup } from "./liveEntities";

/** The priority as one surface reads it: the list row with what only `show` has laid on. */
export type PriorityView = PriorityRow & { corrections: PriorityCorrection[]; other_sessions: PrioritySession[] };

/** A `priorityDetails` row: keyed by the priority's _id. */
export type PriorityDetailRow = {
  _id: string;
  short_id: string;
  corrections: PriorityCorrection[];
  other_sessions: PrioritySession[];
  /** Only for a priority whose list row carries no links. */
  links?: PriorityMilestoneLinks[];
  plan?: PriorityPlanRef | null;
  /** The row itself, only for a priority the list does not hold. */
  base?: PriorityRow;
  _cachedAt?: number;
};

/** How one `show` answer lands: only what the list row (if the store holds one) lacks. */
export function detailRowOf(show: PriorityDetail, listed: PriorityRow | undefined, prev: PriorityDetailRow | undefined, now: number): PriorityDetailRow {
  const { corrections, other_sessions, links, plan, steps, ...rest } = show;
  const row: PriorityDetailRow = { _id: String(show._id), short_id: show.short_id, corrections, other_sessions, _cachedAt: cachedAt(prev, now) };
  if (!listed?.links) {
    row.links = links;
    row.plan = plan ?? null;
  }
  // `show`'s steps carry their sessions; the base keeps a list row's shape. A rank is the viewer's own order (withLiveRanks): a teammate's has none.
  if (!listed) row.base = { ...rest, rank: rest.mine ? rest.rank : null, steps: steps.map(({ sessions: _s, ...step }) => step) } as PriorityRow;
  return row;
}

const NONE: PriorityCorrection[] = [];
const NO_SESSIONS: PrioritySession[] = [];
const views = new WeakMap<PriorityRow, Map<PriorityDetailRow | null, PriorityView>>();

/** The list row (else the detail's base) with the detail laid on; the same object while neither changes. */
export function priorityView(list: PriorityRow | undefined, detail: PriorityDetailRow | undefined): PriorityView | undefined {
  const base = list ?? detail?.base;
  if (!base) return undefined;
  let byDetail = views.get(base);
  if (!byDetail) views.set(base, (byDetail = new Map()));
  const key = detail ?? null;
  let view = byDetail.get(key);
  if (!view) {
    const fromDetail = !base.links && !!detail?.links;
    view = {
      ...base,
      links: fromDetail ? detail!.links : base.links,
      plan: fromDetail ? detail!.plan ?? null : base.plan,
      corrections: detail?.corrections ?? NONE,
      other_sessions: detail?.other_sessions ?? NO_SESSIONS,
    };
    // One view per detail row the base has met: a detail row is replaced on every push, so the old entries go.
    byDetail.clear();
    byDetail.set(key, view);
  }
  return view;
}

const liveIndex = new WeakMap<object, Record<string, PriorityRow>>();
/** The list's rows by _id with their ranks read live, the same objects until the collection changes. */
function liveRows(coll: Record<string, PriorityRow> | undefined): Record<string, PriorityRow> | undefined {
  if (!coll) return undefined;
  let out = liveIndex.get(coll);
  if (!out) {
    out = {};
    for (const r of withLiveRanks(Object.values(coll))) out[String(r._id)] = r;
    liveIndex.set(coll, out);
  }
  return out;
}

/** A priority by `pri-N` or _id from the store's state, as every surface reads it. */
export function priorityInStore(state: { priorities?: Record<string, PriorityRow>; priorityDetails?: Record<string, PriorityDetailRow> }, ref: string): PriorityView | undefined {
  return priorityView(lookup(liveRows(state.priorities), ref), lookup(state.priorityDetails, ref));
}
