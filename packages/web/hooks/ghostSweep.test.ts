import { describe, expect, it } from "bun:test";
import {
  collectGhostSweepCandidates,
  collectHiddenResurrectionSuspects,
  GHOST_SWEEP_MIN_AGE_MS,
  STUB_SWEEP_MIN_AGE_MS,
  STUB_HEAL_MIN_AGE_MS,
} from "./ghostSweep";
import { DISMISS_RECONCILE_WINDOW_MS } from "../store/inboxStore";

// Regression coverage for ct-36579: dismissing a blank now hard-deletes it
// server-side within seconds (dispatch.applyPatches → reapEmptyConversation),
// and a hard delete has no sync channel to other clients — the ghost sweep is
// their only healer. The sweep must therefore verify YOUNG blank rows; the old
// 26h floor (tuned to the GC's 24h grace, the only deletion path back then)
// left dismissed-elsewhere ghosts in NEW for a day, surviving reloads via IDB.

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
  it("verifies a young blank past the mint floor (a dismissed-elsewhere row must heal fast, not in 26h)", () => {
    const id = convexId("youngblank");
    const { candidates } = collectGhostSweepCandidates(
      storeWith([blank(id, GHOST_SWEEP_MIN_AGE_MS + 60_000)]),
      NOW,
    );
    expect(candidates).toEqual([id]);
  });

  it("skips a blank still inside the mint floor (the summon the user just made)", () => {
    const { candidates } = collectGhostSweepCandidates(
      storeWith([blank(convexId("freshmint"), GHOST_SWEEP_MIN_AGE_MS - 60_000)]),
      NOW,
    );
    expect(candidates).toEqual([]);
  });

  it("never touches engaged or foreign rows", () => {
    const age = GHOST_SWEEP_MIN_AGE_MS + 60_000;
    const current = blank(convexId("currentsess"), age);
    const pinned = blank(convexId("pinnedblank"), age, { is_pinned: true });
    const pending = blank(convexId("pendingsend"), age, { has_pending: true });
    const teammate = blank(convexId("teammates"), age, { user_id: "user0000000000000000000000other0" });
    const nonEmpty = blank(convexId("hasmessages"), age, { message_count: 3 });
    const queued = blank(convexId("queuedmsgs"), age);
    const { stubs, candidates } = collectGhostSweepCandidates(
      storeWith([current, pinned, pending, teammate, nonEmpty, queued], {
        currentSessionId: current._id,
        pendingMessages: { [queued._id]: [{}] },
      }),
      NOW,
    );
    expect(candidates).toEqual([]);
    expect(stubs).toEqual([]);
  });

  it("prunes old local stubs directly but leaves young ones for the create handoff", () => {
    const oldStub = blank("local-stub-old", STUB_SWEEP_MIN_AGE_MS + 60_000);
    const youngStub = blank("local-stub-young", STUB_SWEEP_MIN_AGE_MS - 60_000);
    const inFlight = blank("local-stub-creating", STUB_SWEEP_MIN_AGE_MS + 60_000);
    const { stubs, candidates } = collectGhostSweepCandidates(
      storeWith([oldStub, youngStub, inFlight], {
        pendingSessionCreates: { [inFlight._id]: Promise.resolve("x") },
      }),
      NOW,
    );
    expect(stubs).toEqual([oldStub._id]);
    expect(candidates).toEqual([]);
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

// Regression coverage for ct-37110: a server-deleted conversation WITH messages
// is invisible to the blank-only sweep, its dismiss patch is silently dropped
// by dispatch (no doc to patch), and the dismiss reconcile's clear pass then
// un-hides it on every crawl — dismissing it can never stick. The suspects
// collector must hand exactly the would-be-cleared set to the existence verify.
describe("collectHiddenResurrectionSuspects", () => {
  const dismissed = (id: string, agoMs: number, extra: Record<string, unknown> = {}) =>
    ({ _id: id, message_count: 3, inbox_dismissed_at: NOW - agoMs, user_id: ME, ...extra }) as any;

  it("flags a dismissed non-blank row the server's hidden set doesn't contain", () => {
    const ghost = dismissed(convexId("deletedghost"), 60_000);
    const suspects = collectHiddenResurrectionSuspects(
      storeWith([ghost]), "inbox_dismissed_at", new Set(), NOW,
    );
    expect(suspects).toEqual([ghost._id]);
  });

  it("trusts rows the server still reports hidden (no verify needed)", () => {
    const live = dismissed(convexId("livedismiss"), 60_000);
    const suspects = collectHiddenResurrectionSuspects(
      storeWith([live]), "inbox_dismissed_at", new Set([live._id]), NOW,
    );
    expect(suspects).toEqual([]);
  });

  it("skips rows the clear pass wouldn't touch: old hides, foreign rows, stubs, un-hidden rows", () => {
    const ancient = dismissed(convexId("ancienthide"), DISMISS_RECONCILE_WINDOW_MS + 60_000);
    const foreign = dismissed(convexId("foreignrow"), 60_000, { user_id: "user0000000000000000000000other0" });
    const stub = dismissed("local-stub", 60_000);
    const active = dismissed(convexId("activerow"), 60_000, { inbox_dismissed_at: null });
    const suspects = collectHiddenResurrectionSuspects(
      storeWith([ancient, foreign, stub, active]), "inbox_dismissed_at", new Set(), NOW,
    );
    expect(suspects).toEqual([]);
  });

  it("covers the stashed twin via the field parameter", () => {
    const ghost = { _id: convexId("stashedghost"), message_count: 2, inbox_stashed_at: NOW - 60_000, user_id: ME } as any;
    const suspects = collectHiddenResurrectionSuspects(
      storeWith([ghost]), "inbox_stashed_at", new Set(), NOW,
    );
    expect(suspects).toEqual([ghost._id]);
  });
});
