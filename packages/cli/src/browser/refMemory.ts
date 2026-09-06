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
 * So each snapshot writes down the (role, name, nth) of every ref it printed,
 * where nth is the position among the elements sharing that role and name in
 * document order. On a stale ref we re-snapshot and take the nth namesake —
 * the same coordinate the ref was minted with, so the retry lands on the row
 * the agent chose rather than the first one that answers to the name
 * (ct-49555).
 *
 * The table is per browser session, next to the `last-find` pointer, and is
 * pure cache: losing it costs one failed retry, never correctness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { engineHome } from "./engine.js";

export interface RememberedRef {
  role: string;
  name: string;
  /** Position among same role and name, from 1. Absent when the name is
   *  unique on the page, which is the common case. */
  nth?: number;
}

/** A ref as a snapshot printed it: the engine's `e12` (no `@`), plus its
 *  tuple. */
export interface SnapshotRefEntry extends RememberedRef {
  ref: string;
}

/** A big app snapshots to a few hundred refs; the cap is only there so a
 *  pathological page cannot leave megabytes behind. */
const MAX_ENTRIES = 2000;

function tablePath(session: string): string {
  return path.join(engineHome(), "sessions", session, "snapshot-refs.json");
}

/** Record what a snapshot just showed. Best effort: a cache that cannot be
 *  written is a slower recovery, not a failure. */
export function rememberSnapshotRefs(session: string, refs: SnapshotRefEntry[]): void {
  const table: Record<string, RememberedRef> = {};
  for (const r of refs.slice(0, MAX_ENTRIES)) {
    table[r.ref] = r.nth === undefined ? { role: r.role, name: r.name } : { role: r.role, name: r.name, nth: r.nth };
  }
  try {
    fs.mkdirSync(path.dirname(tablePath(session)), { recursive: true });
    fs.writeFileSync(tablePath(session), JSON.stringify(table));
  } catch {
    /* courtesy only */
  }
}

/** What the last snapshot said `ref` (`e12` or `@e12`) was. */
export function recallSnapshotRef(session: string, ref: string): RememberedRef | null {
  try {
    const table = JSON.parse(fs.readFileSync(tablePath(session), "utf-8")) as Record<string, RememberedRef>;
    const entry = table[ref.replace(/^@/, "")];
    return entry && typeof entry.role === "string" ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Which ref to retry a stale one with, given what it used to be and what a
 * fresh snapshot holds now.
 *
 * The nth namesake first — that is the coordinate the ref was minted with — and
 * the first namesake when the list has since grown shorter, because acting on
 * a plausible neighbour beats reporting a dead ref for a row that is plainly
 * still there. Pure, so the choice is pinned by test without a browser.
 */
export function recoverRefPlan(entry: RememberedRef | null, fresh: SnapshotRefEntry[]): string | null {
  if (!entry) return null;
  const namesakes = fresh.filter((f) => f.role === entry.role && f.name === entry.name);
  if (!namesakes.length) return null;
  return (namesakes[(entry.nth ?? 1) - 1] ?? namesakes[0]).ref;
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
