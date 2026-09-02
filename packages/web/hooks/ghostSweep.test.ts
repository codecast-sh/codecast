import { describe, expect, it } from "bun:test";
import {
  collectGhostSweepCandidates,
  STUB_SWEEP_MIN_AGE_MS,
  STUB_HEAL_MIN_AGE_MS,
} from "./ghostSweep";

// The stub sweep is local cruft cleanup: an optimistic create that never
// landed server-side exists in this cache alone. Server-side deletions ride
// the sync log (a delete action, applied on authorized absence) and are not
// this sweep's job — a real Convex id is never a candidate here.

const ME = "user000000000000000000000000meme";
const NOW = 1_750_000_000_000;

const convexId = (tag: string) => tag.padEnd(32, "0").slice(0, 32).toLowerCase();

function blank(id: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    message_count: 0,
    started_at: NOW - ageMs,
    updated_at: NOW - ageMs,
    user_id: ME,
    ...extra,
  } as any;
}

function storeWith(sessions: any[], extra: Record<string, unknown> = {}) {
  return {
    sessions: Object.fromEntries(sessions.map((s) => [s._id, s])),
    pendingMessages: {},
    pendingSessionCreates: {},
    currentSessionId: null,
    currentUser: { _id: ME },
    ...extra,
  } as any;
}

describe("collectGhostSweepCandidates", () => {
  it("never touches a real row, however blank or old (deletions ride the sync log)", () => {
    const age = STUB_SWEEP_MIN_AGE_MS + 60_000;
    const current = blank(convexId("currentsess"), age);
    const pinned = blank(convexId("pinnedblank"), age, { is_pinned: true });
    const pending = blank(convexId("pendingsend"), age, { has_pending: true });
    const teammate = blank(convexId("teammates"), age, { user_id: "user0000000000000000000000other0" });
    const nonEmpty = blank(convexId("hasmessages"), age, { message_count: 3 });
    const plain = blank(convexId("plainblank"), age);
    const { stubs, strandedStubs } = collectGhostSweepCandidates(
      storeWith([current, pinned, pending, teammate, nonEmpty, plain], { currentSessionId: current._id }),
      NOW,
    );
    expect(stubs).toEqual([]);
    expect(strandedStubs).toEqual([]);
  });

  // Regression coverage for ct-40670: a PINNED orphaned stub was exempt from
  // the stub sweep — the only path that can delete it (the server never had
  // the row, so unpin/kill patches are dropped) — making it an immortal ghost
  // that resurrected from IDB on every launch. Pinned stubs must sweep; the
  // pin exemption is only meaningful for real (Convex-id) rows.
  it("never sweeps a kept draft (compose 'save draft' stub outlives every janitor)", () => {
    const draftStub = blank("draftstub12345678901xx", STUB_SWEEP_MIN_AGE_MS + 60_000, { _hasDraft: true });
    const draftBlank = blank(convexId("draftblank"), STUB_SWEEP_MIN_AGE_MS + 60_000, { _hasDraft: true });
    const { stubs } = collectGhostSweepCandidates(storeWith([draftStub, draftBlank]), NOW);
    expect(stubs).toEqual([]);
  });

  it("sweeps a pinned orphaned stub (pin can't protect a row the server never had)", () => {
    const pinnedStub = blank("local-stub-pinned", STUB_SWEEP_MIN_AGE_MS + 60_000, {
      is_pinned: true,
      inbox_pinned_at: NOW - STUB_SWEEP_MIN_AGE_MS,
    });
    const { stubs } = collectGhostSweepCandidates(storeWith([pinnedStub]), NOW);
    expect(stubs).toEqual([pinnedStub._id]);
  });

  it("still exempts a pinned stub whose create is in flight (a legitimate pin mid-create rekeys and flushes)", () => {
    const pinnedInFlight = blank("local-stub-pinned-creating", STUB_SWEEP_MIN_AGE_MS + 60_000, {
      is_pinned: true,
    });
    const { stubs } = collectGhostSweepCandidates(
      storeWith([pinnedInFlight], {
        pendingSessionCreates: { [pinnedInFlight._id]: Promise.resolve("x") },
      }),
      NOW,
    );
    expect(stubs).toEqual([]);
  });

  it("prunes old local stubs directly but leaves young ones for the create handoff", () => {
    const oldStub = blank("local-stub-old", STUB_SWEEP_MIN_AGE_MS + 60_000);
    const youngStub = blank("local-stub-young", STUB_SWEEP_MIN_AGE_MS - 60_000);
    const inFlight = blank("local-stub-creating", STUB_SWEEP_MIN_AGE_MS + 60_000);
    const { stubs } = collectGhostSweepCandidates(
      storeWith([oldStub, youngStub, inFlight], {
        pendingSessionCreates: { [inFlight._id]: Promise.resolve("x") },
      }),
      NOW,
    );
    expect(stubs).toEqual([oldStub._id]);
  });

  // Regression coverage for ct-37441: a "New Session" whose createSession was
  // given up (offline/outage/rate-limit) strands a stub the user typed into.
  // It has a pending message (so the blank prune skips it) and no server
  // conversation (so the message can never deliver) — a permanent stuck ghost.
  // The heal sweep must re-collect exactly these so they get re-created + re-sent.
  // A stub that gets healed must carry a path — the heal re-creates from it.
  const typed = (id: string, ageMs: number, extra: Record<string, unknown> = {}) =>
    blank(id, ageMs, { project_path: "/Users/me/proj", ...extra });

  it("flags a stranded stub the user typed into (pending message, create given up)", () => {
    const stranded = typed("stub-stranded", STUB_HEAL_MIN_AGE_MS + 1_000);
    const { strandedStubs, stubs } = collectGhostSweepCandidates(
      storeWith([stranded], { pendingMessages: { [stranded._id]: [{ content: "hi" }] } }),
      NOW,
    );
    expect(strandedStubs).toEqual([stranded._id]);
    // Disjoint from the blank-prune list — a typed-into stub must heal, not prune.
    expect(stubs).toEqual([]);
  });

  it("leaves a stranded stub alone while its create is still in flight", () => {
    const creating = typed("stub-creating", STUB_HEAL_MIN_AGE_MS + 1_000);
    const { strandedStubs } = collectGhostSweepCandidates(
      storeWith([creating], {
        pendingMessages: { [creating._id]: [{ content: "hi" }] },
        pendingSessionCreates: { [creating._id]: Promise.resolve("x") },
      }),
      NOW,
    );
    expect(strandedStubs).toEqual([]);
  });

  it("waits out the heal floor (a normal create / outbox replay gets to settle first)", () => {
    const young = typed("stub-young-typed", STUB_HEAL_MIN_AGE_MS - 1_000);
    const { strandedStubs } = collectGhostSweepCandidates(
      storeWith([young], { pendingMessages: { [young._id]: [{ content: "hi" }] } }),
      NOW,
    );
    expect(strandedStubs).toEqual([]);
  });

  it("skips a typed-into stub with no project/git path (pathless re-create can't spawn)", () => {
    const pathless = blank("stub-pathless", STUB_HEAL_MIN_AGE_MS + 1_000); // no project_path/git_root
    const { strandedStubs } = collectGhostSweepCandidates(
      storeWith([pathless], { pendingMessages: { [pathless._id]: [{ content: "hi" }] } }),
      NOW,
    );
    expect(strandedStubs).toEqual([]);
  });

  it("ignores foreign stranded stubs and real (convex-id) conversations", () => {
    const foreign = typed("stub-foreign", STUB_HEAL_MIN_AGE_MS + 1_000, { user_id: "user0000000000000000000000other0" });
    const real = typed(convexId("realconvmsg"), STUB_HEAL_MIN_AGE_MS + 1_000);
    const { strandedStubs } = collectGhostSweepCandidates(
      storeWith([foreign, real], {
        pendingMessages: { [foreign._id]: [{ content: "hi" }], [real._id]: [{ content: "hi" }] },
      }),
      NOW,
    );
    expect(strandedStubs).toEqual([]);
  });

  it("does not flag a blank stub with no pending message (that is prune territory)", () => {
    const blankStub = blank("stub-blank", STUB_SWEEP_MIN_AGE_MS + 1_000);
    const { strandedStubs, stubs } = collectGhostSweepCandidates(
      storeWith([blankStub]),
      NOW,
    );
    expect(strandedStubs).toEqual([]);
    expect(stubs).toEqual([blankStub._id]);
  });
});

