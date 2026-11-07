/**
 * What the last snapshot said each ref was, so a ref that goes stale can be
 * recovered instead of just failing.
 *
 * The engine anchors a ref to a node and, when that node is gone, re-resolves
 * it by role and name — which on a list of rows that all say "Delete" lands on
 * the FIRST namesake, not the row the agent meant. It also gives up entirely
 * once the old node is detached and the name is ambiguous:
 *
 *     ✗ Could not locate element with role=button name=Delete
 *
 * Our own recovery had a narrower version of the same hole: it fired only for
 * a bare action after `find`, and re-found by the remembered words. An agent
 * that read a snapshot and typed `click #e5` got no recovery at all.
 *
 * So each snapshot writes down the URL it was taken on and the (role, name,
 * nth, of) of every ref it printed, where nth is the position among the
 * elements sharing that role and name in document order and `of` is how many
 * there were. On a stale ref we re-snapshot and take the nth namesake only when
 * the page is the same and the namesakes still number the same; otherwise the
 * retry is refused and the agent is told to snapshot again (ct-49555,
 * ct-87418).
 *
 * Recovery after a failure is not enough on its own, because the engine
 * often does not fail: see preflightRefPlan, which checks before acting.
 *
 * The table is per browser session, next to the `last-find` pointer, and is
 * pure cache: losing it (or an old table without a URL) costs one refused
 * retry, never correctness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { engineHome } from "./engine.js";
import type { PageStamp, SettleProbe } from "./snapshotSettle.js";

export interface RememberedRef {
  role: string;
  name: string;
  /** Position among same role and name, from 1. Absent when the name is
   *  unique on the page, which is the common case. */
  nth?: number;
  /** How many namesakes the page held when the ref was minted. A recovery
   *  that finds a different count knows the rows moved under the ordinal. */
  of?: number;
}

/** A ref as a snapshot printed it: the engine's `e12` (no `@`), plus its
 *  tuple. */
export interface SnapshotRefEntry extends RememberedRef {
  ref: string;
}

/** What `recallSnapshotRef` hands back: the tuple, and the page it was read
 *  on (null when the snapshot could not tell, which recovery treats as a
 *  different page). */
export interface RecalledRef extends RememberedRef {
  url: string | null;
  /** The snapshot's document token and page time (snapshotSettle.ts
   *  PageStamp); absent in a table written before they were recorded. */
  doc?: string | null;
  at?: number;
}

interface Table {
  url: string | null;
  doc?: string | null;
  at?: number;
  refs: Record<string, RememberedRef>;
}

/** A big app snapshots to a few hundred refs; the cap is only there so a
 *  pathological page cannot leave megabytes behind. */
const MAX_ENTRIES = 2000;

function tablePath(session: string): string {
  return path.join(engineHome(), "sessions", session, "snapshot-refs.json");
}

/** Record what a snapshot just showed, and the URL it showed it on. Best
 *  effort: a cache that cannot be written is a failed recovery, not a wrong
 *  one. */
export function rememberSnapshotRefs(session: string, refs: SnapshotRefEntry[], page: PageStamp | null): void {
  const counts = new Map<string, number>();
  for (const r of refs) counts.set(`${r.role}\0${r.name}`, (counts.get(`${r.role}\0${r.name}`) ?? 0) + 1);
  const table: Table = page ? { url: page.url, doc: page.doc, at: page.at, refs: {} } : { url: null, refs: {} };
  for (const r of refs.slice(0, MAX_ENTRIES)) {
    const of = counts.get(`${r.role}\0${r.name}`) ?? 1;
    table.refs[r.ref] = r.nth === undefined ? { role: r.role, name: r.name } : { role: r.role, name: r.name, nth: r.nth, of };
  }
  try {
    fs.mkdirSync(path.dirname(tablePath(session)), { recursive: true });
    fs.writeFileSync(tablePath(session), JSON.stringify(table));
  } catch {
    /* courtesy only */
  }
}

/** What the last snapshot said `ref` (`e12` or `@e12`) was. */
export function recallSnapshotRef(session: string, ref: string): RecalledRef | null {
  try {
    const table = JSON.parse(fs.readFileSync(tablePath(session), "utf-8")) as Partial<Table>;
    const entry = table.refs?.[ref.replace(/^@/, "")];
    if (!entry || typeof entry.role !== "string") return null;
    return {
      ...entry,
      url: typeof table.url === "string" ? table.url : null,
      ...(table.doc !== undefined ? { doc: table.doc } : {}),
      ...(typeof table.at === "number" ? { at: table.at } : {}),
    };
  } catch {
    return null;
  }
}

/** The URL the session's last snapshot was taken on, or null. */
export function rememberedSnapshotUrl(session: string): string | null {
  try {
    const table = JSON.parse(fs.readFileSync(tablePath(session), "utf-8")) as Partial<Table>;
    return typeof table.url === "string" ? table.url : null;
  } catch {
    return null;
  }
}

export const SNAPSHOT_AGAIN = "take a fresh `cast browser snapshot` and act on the new ref";

/** The answer to "may a stale ref be retried, and as what". */
export type RecoveryPlan = { ref: string } | { refused: string };

/**
 * Which ref to retry a stale one with, given what it used to be, what a fresh
 * snapshot holds now, and the URL that fresh snapshot was taken on.
 *
 * Only the exact coordinate the ref was minted with qualifies: the same page
 * (URL unchanged), and the nth namesake among the same number of namesakes.
 * Anything else refuses, because a plausible neighbour is how the wrong row
 * gets deleted: a list that lost a row shifts every ordinal after it, and a
 * page that navigated may hold an unrelated control with the same name. A
 * refusal costs the agent one snapshot; a wrong recovery reports success for
 * an action on the wrong thing. Pure, so the choice is pinned by test.
 */
export function recoverRefPlan(entry: RecalledRef | null, fresh: SnapshotRefEntry[], currentUrl: string | null): RecoveryPlan {
  if (!entry) return { refused: `the ref is not in the last snapshot; ${SNAPSHOT_AGAIN}` };
  if (!entry.url || !currentUrl || entry.url !== currentUrl) {
    return { refused: `the page changed since the snapshot (${entry.url ?? "unknown"} → ${currentUrl ?? "unknown"}); ${SNAPSHOT_AGAIN}` };
  }
  const label = `${entry.role} ${JSON.stringify(entry.name)}`;
  const namesakes = fresh.filter((f) => f.role === entry.role && f.name === entry.name);
  if (!namesakes.length) return { refused: `no ${label} is on the page any more; ${SNAPSHOT_AGAIN}` };
  const nth = entry.nth ?? 1;
  const was = entry.of ?? 1;
  if (namesakes.length !== was || !namesakes[nth - 1]) {
    return {
      refused: `the page now has ${namesakes.length} ${label} where the snapshot had ${was}, so which one was meant is no longer certain; ${SNAPSHOT_AGAIN}`,
    };
  }
  return { ref: namesakes[nth - 1].ref };
}

/**
 * May an action on this ref go ahead, judged before it is sent.
 *
 * The engine does not fail on a ref whose node is gone: it re-resolves it by
 * role, name and position, and acts on whatever holds that position now. On a
 * list of identical "Delete" buttons that lost a row, that is the next row,
 * reported as success (seen on the rig, ct-87418). So the check runs first,
 * against one probe of the page (`probe`, from snapshotSettle.ts's
 * settleProbeSource), and refuses when:
 *
 *   - the document is not the one the snapshot read (a navigation or a
 *     reload: a new document token), or the URL moved;
 *   - the ref is one of several namesakes and an element was added or
 *     removed since the snapshot, so its ordinal may name another element.
 *
 * A unique ref on an unchanged document passes even after mutations, since
 * re-resolving a unique name lands on the same control. A ref the table does
 * not hold, an old table without a stamp, or a page that could not be probed
 * pass too: the engine's own resolution and the stale-ref path (recoverRefPlan)
 * still apply. Pure, so the rules are pinned by test.
 */
export function preflightRefPlan(entry: RecalledRef | null, probe: SettleProbe | null): { refused: string } | null {
  if (!entry || !probe || entry.at === undefined) return null;
  if (entry.doc && probe.doc !== entry.doc) {
    return { refused: `the page navigated or reloaded since the snapshot; ${SNAPSHOT_AGAIN}` };
  }
  if (entry.url && probe.url !== entry.url) {
    return { refused: `the page changed since the snapshot (${entry.url} → ${probe.url}); ${SNAPSHOT_AGAIN}` };
  }
  if ((entry.of ?? 1) > 1 && (probe.treeAt === null || probe.treeAt > entry.at)) {
    return {
      refused: `elements were added or removed since the snapshot, so which of the ${entry.of} ${entry.role} ${JSON.stringify(entry.name)} was meant is no longer certain; ${SNAPSHOT_AGAIN}`,
    };
  }
  return null;
}

/**
 * Whether a failure is the engine saying the ref no longer addresses anything.
 *
 * The retry re-runs the command, so it must never follow a failure that could
 * have acted on the page — a `click` that half-succeeded and then errored would
 * otherwise be clicked twice. These four are the engine's own wording for a ref
 * it could not resolve, checked before anything ran.
 */
export function isStaleRefFailure(text: string): boolean {
  return /unknown ref|could not locate element|element not found|no objectid for ref/i.test(text);
}
