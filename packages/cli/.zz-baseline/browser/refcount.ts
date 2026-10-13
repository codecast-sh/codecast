/**
 * Shared-fate ownership: who is holding the browser open, and what `cast
 * browser stop` may therefore do.
 *
 * One browser serves every agent on the machine, so "stop" cannot mean "kill
 * it" unconditionally: that yanks the browser out from under every other agent
 * mid-flow. The rule is refcounting by session. A session registers interest
 * the first time it acts (owner.ts gives it its key; instance.ts records the
 * tab it acts in), releases on `stop`, and only the LAST holder takes the
 * browser down. `--force` restores the old shared-fate behaviour, naming who
 * it hits.
 *
 * Two engines drive `cast browser`, so the decision is split in two layers.
 * `decideStop` is the engine-agnostic core: given who else holds and who is
 * asking, what happens. Below it, the built-in engine derives holders from
 * its tab-ownership map (`tabsBySession` — the same map that marks `*` and
 * `~` in `cast browser tabs`, deliberately not a second registry) stamped
 * with when each holder last acted; the agent-browser adapter derives them
 * from `agent-browser session list`. Same contract either way.
 */

import { readState, writeState, type InstanceState } from "./instance.js";

// ---------------------------------------------------------------- core

export type StopPlan =
  | { action: "teardown"; others: string[] }
  | { action: "release"; others: string[] }
  | { action: "refuse"; others: string[] };

/**
 * What `stop` should do for this caller, engine-agnostic.
 *
 *   - nobody else holds, or `force`  → teardown (force names `others`)
 *   - others hold and the caller has an identity → release the caller's own
 *   - others hold and the caller has none → refuse: it cannot know what is
 *     "its own" to release, and guessing would tear down someone's work
 */
export function decideStop(input: { others: string[]; me: string | null; force?: boolean }): StopPlan {
  const others = input.others.filter((sid) => sid !== input.me);
  if (input.force || others.length === 0) return { action: "teardown", others };
  if (!input.me) return { action: "refuse", others };
  return { action: "release", others };
}

/** Holder keys as an agent reads them: the owner prefix carries no meaning here. */
export function describeHolders(ids: string[]): string {
  return ids.map((s) => s.replace(/^(session|env|pane):/, "")).join(", ");
}

// ---------------------------------------------------------------- built-in engine

/** A holder that has run nothing for this long is presumed gone. */
export const HOLDER_STALE_MS = 90 * 60 * 1000;

/**
 * Sessions currently holding the built-in browser open: every session with a
 * tab in `tabsBySession` whose tab still exists and which has been seen
 * recently. `liveTargetIds` may be omitted when the tab list is unknown.
 */
export function liveHolders(state: InstanceState, liveTargetIds?: Set<string>, now = Date.now()): string[] {
  const seen = state.sessionSeenAt ?? {};
  return Object.entries(state.tabsBySession ?? {})
    .filter(([sid, tab]) => {
      if (liveTargetIds && !liveTargetIds.has(tab)) return false;
      const at = seen[sid];
      // No stamp means the entry predates stamping; its tab existing is all we
      // know, so it counts — a false "still here" only delays a shutdown, while
      // a false "gone" kills someone's work.
      return at === undefined || now - at <= HOLDER_STALE_MS;
    })
    .map(([sid]) => sid);
}

export type BuiltinStopPlan = StopPlan & { myTabs: string[] };

/** `decideStop` for the built-in engine, with the caller's tabs to close on release. */
export function planStop(
  state: InstanceState,
  me: string | null,
  opts: { force?: boolean; liveTargetIds?: Set<string>; now?: number } = {},
): BuiltinStopPlan {
  const plan = decideStop({ others: liveHolders(state, opts.liveTargetIds, opts.now), me, force: opts.force });
  const myTab = me ? state.tabsBySession?.[me] : undefined;
  const myTabs = myTab && (!opts.liveTargetIds || opts.liveTargetIds.has(myTab)) ? [myTab] : [];
  return { ...plan, myTabs };
}

/** Forget a session's claim on the built-in browser (its tab entry and its stamp). */
export function releaseSession(state: InstanceState, sessionId: string): InstanceState {
  const current = readState() ?? state;
  const tabs = { ...(current.tabsBySession ?? {}) };
  const seen = { ...(current.sessionSeenAt ?? {}) };
  const released = tabs[sessionId];
  delete tabs[sessionId];
  delete seen[sessionId];
  const next: InstanceState = {
    ...current,
    tabsBySession: tabs,
    sessionSeenAt: seen,
    activeTargetId: current.activeTargetId === released ? null : current.activeTargetId,
  };
  writeState(next);
  return next;
}
