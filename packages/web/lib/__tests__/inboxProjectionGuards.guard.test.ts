import { describe, expect, test } from "bun:test";
import { WEB_ROOT, offendersUnder } from "./sourceWalk";

// INBOX PROJECTION GUARDS (docs/architecture/sync-convergence.md C1, C4, C6).
//
// Three source-level invariants keep the replica model honest:
//
// 1. STAMPS ARE CHECKING DATA. The per-scope `sessionsProjection` buffer holds
//    the server's projection stamps; only its owner (the store applier) and the
//    digest compare may read it. A render path that reaches into it is a
//    server-rendered verdict — the exact thing the replica model removes.
//
// 2. VIEW KEYS PARAMETERIZE, NEVER BYPASS. `inbox_show_old` and `inbox_scope`
//    are synced view state that the counting chokepoint (computeInboxVisible)
//    reads; show-old selects shown + folded INSIDE the shared computation. A
//    new reader of these keys is a new counting path — the divergence class
//    (panel 24 / badge 25 / mobile 50) this design deleted.
//
// 3. STAMP FIELDS NEVER RIDE SESSION ROWS. `work_state`, `below_fold`,
//    `bucket_stale_at`, `stale_bucket` exist on rows only inside server
//    payloads; every row channel strips them (runtime-tested in
//    store/__tests__/inboxProjectionBuffer.test.ts). Render code referencing
//    them is reading a field that cannot exist on a store row.
//
// If this fails on new code, route the read through the chokepoint (or, for
// the compare, the compare module) — do not widen an allowlist.

const offendersFor = (dirs: string[], token: RegExp, allowed: ReadonlyMap<string, string>) =>
  offendersUnder(WEB_ROOT, dirs, token, allowed);

const ALL_DIRS = ["app", "components", "hooks", "lib", "store", "src", "shortcuts", "tips"];

describe("sessionsProjection is read only by its owner and the compare", () => {
  test("no file outside the store owner / compare module touches the stamp buffer", () => {
    const allowed = new Map<string, string>([
      // The owner: the overlay applier writes it; renderInboxEpoch (the render
      // clock) and the recompute scheduling read the envelope, never a stamp
      // as a render source.
      ["store/inboxStore.ts", "buffer owner: applier + envelope clock"],
      // The digest compare (sync-convergence C6) — the buffer's one consumer.
      ["store/inboxDigestCompare.ts", "the compare module (ct-47203)"],
    ]);
    expect(offendersFor(ALL_DIRS, /\bsessionsProjection\b/, allowed)).toEqual([]);
  }, 120_000);
});

describe("the chokepoint is the only counting reader of the synced view keys", () => {
  test("inbox_show_old is read nowhere outside the store", () => {
    // Everything — the panel's toggle render included — goes through
    // resolveShowOld / computeInboxVisible, both in the store.
    const allowed = new Map<string, string>([
      ["store/inboxStore.ts", "resolveShowOld + computeInboxVisible + the LWW key registry"],
    ]);
    expect(offendersFor(ALL_DIRS, /\binbox_show_old\b/, allowed)).toEqual([]);
  }, 120_000);

  test("inbox_scope readers are pinned — no new counting path may consult scope directly", () => {
    const allowed = new Map<string, string>([
      ["store/inboxStore.ts", "the chokepoint (computeInboxVisible/filterInboxScope), LWW registry, boot seed"],
      ["hooks/useSyncTeamInboxSessions.ts", "feeder mount gate: which subscriptions run, not what counts"],
      ["components/GlobalSessionPanel.tsx", "chokepoint memo dep + the scope toggle write"],
      ["components/FleetBoard.tsx", "chokepoint memo dep"],
    ]);
    expect(offendersFor(ALL_DIRS, /\binbox_scope\b/, allowed)).toEqual([]);
  }, 120_000);
});

describe("projection stamp fields never appear in render code", () => {
  test("work_state / below_fold / bucket_stale_at / stale_bucket are absent from app, components, hooks, lib", () => {
    // The store owns the buffer types (its own mentions are the buffer and the
    // strip list), so it is out of scope here; everything that RENDERS is in.
    const allowed = new Map<string, string>([
      // Renders feedForCLI items (the CLI-shaped feed payload, a different
      // contract) — not store session rows.
      ["components/StableContextCards.tsx", "StableContextItem.work_state from feedForCLI"],
    ]);
    const offenders = offendersFor(
      ["app", "components", "hooks", "lib", "src", "shortcuts", "tips"],
      /\b(work_state|below_fold|bucket_stale_at|stale_bucket)\b/,
      allowed,
    );
    expect(offenders).toEqual([]);
  }, 120_000);
});
