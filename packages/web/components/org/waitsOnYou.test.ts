// Waits on you (essence spec 6.1): which rows exist, in what order, what each
// says and opens, and that nothing but a live decision or an open proposal
// can add one. Run: bun test components/org/waitsOnYou.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORG_FIXTURE_WITH_HEAD } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import type { OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import { waitingRoleIds, waitsOnYou, waitsTreeSig, type WaitsInput } from "./waitsOnYou";

const TEAM = { kind: "team" as const, id: "fixture-team" };
const HEAD_ID = "fixture-role-head";
const GROWTH_ID = ORG_FIXTURE_WITH_HEAD.roles.find((r) => r.handle === "growth")!._id;

const decide = (extra: Record<string, unknown> = {}): any => ({ key: "decide:1", source: "decide", conversationId: "fixture-growth-conv", question: "Keep the spring ads running?", options: [{ label: "Yes" }, { label: "No" }], blocking: true, createdAt: 100, decisionId: "sd1", ...extra });

// A list row as the store holds it: no change rows, the server's counts.
const proposal = (short: string, created_at: number, extra: Partial<OrgProposalRow> = {}): OrgProposalRow => ({
  ...ORG_STAFFING_FIXTURE_PROPOSAL,
  _id: `p-${short}`,
  short_id: short,
  title: `Proposal ${short}`,
  created_at,
  changes: [],
  counts: { total: 3, decided: 0, applied: 0, failed: 0, skipped: 0 },
  ...extra,
});

const run = (over: Partial<WaitsInput>) => waitsOnYou({ tree: ORG_FIXTURE_WITH_HEAD, queue: [], proposals: [], workspace: TEAM, ...over });

describe("Waits on you", () => {
  test("a decision from an org conversation is one row that opens the asking conversation, answerable in place when it is a short single choice", () => {
    const [row] = run({ queue: [decide()] });
    expect(row).toMatchObject({
      kind: "decision",
      roleId: GROWTH_ID,
      who: { name: "Head of Growth", face: { handle: "growth" } },
      verb: "asks",
      words: "Keep the spring ads running?",
      count: 1,
      at: 100,
      target: { kind: "session", id: "fixture-growth-conv" },
      answer: { decisionId: "sd1", options: ["Yes", "No"] },
    });
    // A multi-choice card, or one with many options, opens rather than answers.
    expect(run({ queue: [decide({ kind: "multi" })] })[0].answer).toBeUndefined();
    expect(run({ queue: [decide({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `${n}` })) })] })[0].answer).toBeUndefined();
  });

  test("a decision outside the org, or one a role holds under a grant, is not a row", () => {
    expect(run({ queue: [decide({ conversationId: "somebody-elses-session" }), decide({ key: "decide:2", heldByRole: true })] })).toEqual([]);
  });

  test("a blocked pin alone adds no row, and the role does not read as waiting on you", () => {
    const tree: OrgTree = { ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => r._id === GROWTH_ID ? { ...r, standing: { ...r.standing!, state_status: "blocked", state_line: "Waiting on Ashot for the budget" } } : r) };
    const items = run({ tree });
    expect(items).toEqual([]);
    expect(waitingRoleIds(items).has(GROWTH_ID)).toBe(false);
  });

  test("a stale persisted health snapshot cannot add a row: neither the model nor its hook reads health", () => {
    for (const file of ["waitsOnYou.ts", "useNeedsYou.ts", "WaitsOnYouList.tsx", "OrgNeedsYouBadge.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect({ file, health: /orgHealth|OrgHealth|useSyncOrgHealth/.test(src) }).toEqual({ file, health: false });
    }
  });

  test("three proposals from one proposer make one row with count 3, opening the oldest", () => {
    const items = run({ proposals: [proposal("op-12", 300), proposal("op-10", 100), proposal("op-11", 200)] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "proposals",
      roleId: HEAD_ID,
      who: { name: "Head of People", face: { handle: "head-of-people" } },
      verb: "proposes 3 changes",
      words: "Proposal op-10, and 2 more",
      count: 3,
      at: 100,
      target: { kind: "proposal", id: "op-10" },
    });
    // One proposal says itself.
    expect(run({ proposals: [proposal("op-10", 100)] })[0]).toMatchObject({ verb: "proposes", words: "Proposal op-10", count: 1 });
  });

  test("a proposal leaves once every change is decided, and only the active workspace's open ones count", () => {
    const decided = proposal("op-1", 1, { counts: { total: 3, decided: 3, applied: 2, failed: 0, skipped: 1 } });
    const failed = proposal("op-2", 2, { counts: { total: 3, decided: 3, applied: 2, failed: 1, skipped: 0 } });
    const resolved = proposal("op-3", 3, { status: "resolved" });
    const elsewhere = proposal("op-4", 4, { team_id: "other-team" });
    const items = run({ proposals: [decided, failed, resolved, elsewhere] });
    // A failed change is still to decide: the server takes it again.
    expect(items.map((i) => i.target)).toEqual([{ kind: "proposal", id: "op-2" }]);
    expect(items[0].count).toBe(1);
    // The change rows, when the store holds them, win over the counts: deciding locally clears the row at once.
    const local = proposal("op-5", 5, { changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => ({ ...c, status: "applied" as const })) });
    expect(run({ proposals: [local] })).toEqual([]);
  });

  test("proposers stay apart: a session filed under a role proposes as that role, a person as themselves", () => {
    const fromSession = proposal("op-20", 20, { author: { kind: "session", id: "fixture-growth-conv", title: "growth thread" } });
    const fromPerson = proposal("op-21", 10, { author: { kind: "user", id: "u-1", name: "Samvit Jain" } });
    const items = run({ proposals: [proposal("op-22", 30), fromSession, fromPerson] });
    expect(items.map((i) => [i.who.name, i.roleId, i.count])).toEqual([["Samvit Jain", null, 1], ["Head of Growth", GROWTH_ID, 1], ["Head of People", HEAD_ID, 1]]);
    expect(waitingRoleIds(items)).toEqual(new Set([GROWTH_ID, HEAD_ID]));
  });

  test("decisions come first, then proposals, each oldest first; a decision that only points at an open proposal is that proposal's row", () => {
    const queue = [
      decide({ key: "decide:late", createdAt: 500 }),
      decide({ key: "decide:early", conversationId: "fixture-head-conv", createdAt: 50, question: "Which market first?" }),
      decide({ key: "decide:proposal", conversationId: "fixture-head-conv", createdAt: 60, question: "Review op-10?", contextMd: "[Open](/org?proposal=op-10)" }),
    ];
    const items = run({ queue, proposals: [proposal("op-10", 1)] });
    expect(items.map((i) => i.key)).toEqual(["decide:early", "decide:late", `proposals:role:${HEAD_ID}`]);
    expect(waitingRoleIds(items)).toEqual(new Set([HEAD_ID, GROWTH_ID]));
  });

  test("before the active workspace's tree lands, decisions wait rather than match another workspace's roles", () => {
    expect(run({ tree: null, queue: [decide()] })).toEqual([]);
  });

  test("the tree signature moves only with what the rows read", () => {
    const sig = waitsTreeSig(ORG_FIXTURE_WITH_HEAD);
    expect(waitsTreeSig({ ...ORG_FIXTURE_WITH_HEAD, generated_at: ORG_FIXTURE_WITH_HEAD.generated_at + 1, people: [] })).toBe(sig);
    expect(waitsTreeSig({ ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => r._id === GROWTH_ID ? { ...r, standing: { ...r.standing!, state_line: "new words" } } : r) })).toBe(sig);
    expect(waitsTreeSig({ ...ORG_FIXTURE_WITH_HEAD, roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) => r._id === GROWTH_ID ? { ...r, name: "Growth lead" } : r) })).not.toBe(sig);
  });

  test("the rail count and the list read one source", () => {
    const badge = readFileSync(join(import.meta.dir, "OrgNeedsYouBadge.tsx"), "utf8");
    const hook = readFileSync(join(import.meta.dir, "useNeedsYou.ts"), "utf8");
    const list = readFileSync(join(import.meta.dir, "WaitsOnYouList.tsx"), "utf8");
    expect(badge).toContain("useOrgNeedsYouCount()");
    expect(hook).toMatch(/export function useOrgNeedsYouCount\(\): number \{\s*return useWaitsOnYou\(\)\.length;/);
    expect(list).toContain("useWaitsOnYou()");
  });
});
