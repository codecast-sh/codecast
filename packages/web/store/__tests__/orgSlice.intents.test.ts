// The org tree's pending protection (store/orgSlice.ts header). A meta
// singleton gets no engine pending entry, so an optimistic edit survives a
// stale org.tree push only because the merge replays open intents.
import { describe, expect, it } from "bun:test";
import { create as mutate } from "mutative";
import {
  createOrgSlice,
  mergeOrgTree,
  orgIntentSatisfied,
  dropRejectedOrgIntent,
  lineIntentEchoed,
  orgIntentNoticeText,
  ORG_INTENT_TTL_MS,
  type OrgIntent,
  type OrgSliceData,
} from "../orgSlice";
import { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } from "../../components/org/orgFixture";
import { sortOrgSessions, type OrgTree } from "../../components/org/orgTypes";

const ME = "fixture-user-me";
const SAM = "fixture-user-sam";
const ROLE = "fixture-role-growth";
const clone = (): OrgTree => JSON.parse(JSON.stringify(ORG_FIXTURE));

/** Run a slice action body against a draft, the way the middleware does. */
function run(data: OrgSliceData, name: keyof ReturnType<typeof createOrgSlice>, ...args: any[]): OrgSliceData {
  const slice = createOrgSlice();
  return mutate(data, (draft) => { (slice[name] as any).call(draft, ...args); });
}

describe("org intents", () => {
  it("a session move records an intent that a stale push cannot revert, and the echo clears", () => {
    const before = clone();
    const top = before.people[0].sessions[0];
    let st: OrgSliceData = { orgTree: before, orgIntents: [] };
    st = run(st, "reparentOrgSession", top._id, { kind: "role", role_id: ROLE });
    expect(st.orgIntents).toHaveLength(1);
    expect(st.orgTree!.roles[0].sessions.some((s) => s._id === top._id)).toBe(true);
    expect(st.orgTree!.roles[0].total).toBe(ORG_FIXTURE.roles[0].total + 1);

    // A push that started before the mutation landed carries the OLD shape.
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.intents).toHaveLength(1);
    expect(stale.tree.roles[0].sessions.some((s) => s._id === top._id)).toBe(true);
    expect(stale.tree.people[0].sessions.some((s) => s._id === top._id)).toBe(false);
    // The feeder's object is not mutated in place.
    expect(clone().people[0].sessions.some((s) => s._id === top._id)).toBe(true);

    // The echo: the server files it under the role. Intent gone, tree as sent.
    const echo = clone();
    const i = echo.people[0].sessions.findIndex((s) => s._id === top._id);
    const [moved] = echo.people[0].sessions.splice(i, 1);
    echo.roles[0].sessions.unshift({ ...moved, org_role_id: ROLE });
    const settled = mergeOrgTree(echo, st.orgIntents);
    expect(settled.intents).toHaveLength(0);
    expect(settled.tree).toBe(echo);
  });

  it("a session loaded beyond the top N moves with its counts when the page hands the row over", () => {
    const tree = clone();
    const beyond = sortOrgSessions(ORG_FIXTURE_ALL_SESSIONS.filter((s) => s.owner_user_id === ME && !s.org_role_id))[10];
    expect(tree.people[0].sessions.some((s) => s._id === beyond._id)).toBe(false);
    const meBefore = tree.people[0].total;
    const roleBefore = tree.roles[0].total;
    let st: OrgSliceData = { orgTree: tree, orgIntents: [] };
    st = run(st, "reparentOrgSession", beyond._id, { kind: "role", role_id: ROLE }, beyond);
    expect(st.orgTree!.people[0].total).toBe(meBefore - 1);
    expect(st.orgTree!.roles[0].total).toBe(roleBefore + 1);
    expect(st.orgTree!.roles[0].sessions.some((s) => s._id === beyond._id)).toBe(true);
    // Without the row the slice cannot find it: no intent, no half move.
    const none = run({ orgTree: clone(), orgIntents: [] }, "reparentOrgSession", beyond._id, { kind: "role", role_id: ROLE });
    expect(none.orgIntents).toHaveLength(0);
    expect(none.orgTree!.roles[0].total).toBe(roleBefore);
  });

  it("a role reparent and a follow toggle replay onto a stale push and clear on echo", () => {
    let st: OrgSliceData = { orgTree: clone(), orgIntents: [] };
    st = run(st, "reparentOrgRole", ROLE, { kind: "user", user_id: SAM });
    st = run(st, "followOrgChannel", "or-1", "k".padEnd(32, "0"), true);
    expect(st.orgIntents.map((i) => i.kind)).toEqual(["moveRole", "follow"]);
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.tree.roles[0].reports_to).toEqual({ kind: "user", user_id: SAM });
    expect(stale.tree.roles[0].follow_channel_ids).toEqual(["k".padEnd(32, "0")]);
    const echo = clone();
    echo.roles[0].reports_to = { kind: "user", user_id: SAM };
    echo.roles[0].follow_channel_ids = ["k".padEnd(32, "0")];
    expect(mergeOrgTree(echo, st.orgIntents).intents).toHaveLength(0);
  });

  it("a follow on a stub channel id is refused before it is drawn", () => {
    const st = run({ orgTree: clone(), orgIntents: [] }, "followOrgChannel", "or-1", "chatstub-abc", true);
    expect(st.orgIntents).toHaveLength(0);
    expect(st.orgTree!.roles[0].follow_channel_ids ?? []).toEqual([]);
  });

  it("an intent ages out, and a rejected dispatch drops it at once", () => {
    const old: OrgIntent = { kind: "moveRole", id: "x", role_id: ROLE, reports_to: { kind: "user", user_id: SAM }, at: Date.now() - ORG_INTENT_TTL_MS - 1 };
    expect(mergeOrgTree(clone(), [old]).intents).toHaveLength(0);
    let st: OrgSliceData = { orgTree: clone(), orgIntents: [] };
    st = run(st, "reparentOrgRole", ROLE, { kind: "user", user_id: SAM });
    const dropped: string[] = [];
    const reverted: string[] = [];
    const hooks = { dropOrgIntent: (id: string) => dropped.push(id), revertOrgIntent: (id: string) => reverted.push(id) };
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, ...hooks }, "reparentOrgRole", [ROLE, { kind: "user", user_id: SAM }]);
    expect(dropped).toEqual([st.orgIntents[0].id]);
    expect(reverted).toEqual([]);
    // A different subject is left alone.
    dropped.length = 0;
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, ...hooks }, "reparentOrgRole", ["other-role", {}]);
    expect(dropped).toEqual([]);
  });

  // ---- the staffing kinds (org-staffing.md S5, S6): a verdict flips a change
  // row, a hire puts a stub on the tree; a refusal or a silent loss puts both
  // back through the same journal.
  const CHANGES = () => ({
    "ch-1": { _id: "ch-1", proposal_id: "p-1", seq: 1, change: { kind: "retire", handle: "ops" }, rationale: "r", evidence: [], status: "proposed" as const },
    "ch-2": { _id: "ch-2", proposal_id: "p-1", seq: 2, change: { kind: "trust", handle: "growth", trust: "decide" }, rationale: "r", evidence: [], status: "failed" as const, applied_note: "handle clash" },
    "ch-3": { _id: "ch-3", proposal_id: "p-1", seq: 3, change: { kind: "retire", handle: "qa" }, rationale: "r", evidence: [], status: "applied" as const, decided_by: "u1" },
    "ch-9": { _id: "ch-9", proposal_id: "p-2", seq: 1, change: { kind: "retire", handle: "x" }, rationale: "r", evidence: [], status: "proposed" as const },
  });
  const staffing = (): OrgSliceData => ({ orgTree: clone(), orgIntents: [], orgHealth: null, orgProposals: {}, orgProposalChanges: CHANGES() as any, orgFocusChangeId: null, orgIntentNotice: null });

  it("a verdict flips a proposed or failed row, keeps the edits, and reverts on refusal", () => {
    let st = staffing();
    st = run(st, "decideOrgProposalChange", "ch-1", "accept", { reason: "now" });
    st = run(st, "decideOrgProposalChange", "ch-2", "skip");
    // An applied row is not decidable: no flip, no intent.
    st = run(st, "decideOrgProposalChange", "ch-3", "skip");
    expect(st.orgProposalChanges["ch-1"]).toMatchObject({ status: "accepted", edits: { reason: "now" } });
    expect(st.orgProposalChanges["ch-2"].status).toBe("skipped");
    expect(st.orgProposalChanges["ch-3"].status).toBe("applied");
    expect(st.orgIntents.map((i) => i.kind === "decideChange" && [i.change_id, i.from, i.to])).toEqual([["ch-1", "proposed", "accepted"], ["ch-2", "failed", "skipped"]]);

    // The rail refuses the accept: the row goes back to proposed, edits kept.
    const reverted: string[] = [];
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "decideOrgProposalChange", ["ch-1", "accept"]);
    expect(reverted).toEqual([st.orgIntents[0].id]);
    st = run(st, "revertOrgIntent", reverted[0]);
    expect(st.orgProposalChanges["ch-1"]).toMatchObject({ status: "proposed", edits: { reason: "now" } });
    expect(st.orgProposalChanges["ch-1"].decided_at).toBeUndefined();
    expect(st.orgIntents.map((i) => i.kind === "decideChange" && i.change_id)).toEqual(["ch-2"]);
    // The failed row went back to failed, not proposed.
    st = run(st, "revertOrgIntent", st.orgIntents[0].id);
    expect(st.orgProposalChanges["ch-2"].status).toBe("failed");
  });

  it("accept all flips every decidable row of that proposal, and a refusal reverts them all", () => {
    let st = staffing();
    st = run(st, "acceptAllOrgProposal", "p-1");
    expect(st.orgProposalChanges["ch-1"].status).toBe("accepted");
    expect(st.orgProposalChanges["ch-2"].status).toBe("accepted");
    expect(st.orgProposalChanges["ch-3"].status).toBe("applied");
    expect(st.orgProposalChanges["ch-9"].status).toBe("proposed");
    expect(st.orgIntents).toHaveLength(2);
    const reverted: string[] = [];
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "acceptAllOrgProposal", ["p-1"]);
    expect(reverted).toHaveLength(2);
    for (const id of reverted) st = run(st, "revertOrgIntent", id);
    expect(st.orgProposalChanges["ch-1"].status).toBe("proposed");
    expect(st.orgProposalChanges["ch-2"].status).toBe("failed");
    expect(st.orgIntents).toEqual([]);
  });

  it("the server's decided_by stamp is the echo; a stale push is replayed with its edits; an aged verdict reverts and says so", async () => {
    const { pruneOrgIntents, applyOrgChangeIntent } = await import("../orgSlice");
    let st = staffing();
    st = run(st, "decideOrgProposalChange", "ch-1", "accept", { reason: "now" });
    const intent = st.orgIntents[0] as Extract<OrgIntent, { kind: "decideChange" }>;
    expect(intent.edits).toEqual({ reason: "now" });
    expect(intent.line).toBe("retire @ops");
    // A push that predates the mutation replaced the row with the server's
    // copy (proposed, no edits): the replay flips it back, edits included.
    const stale = { ...st.orgProposalChanges, "ch-1": { ...CHANGES()["ch-1"] } } as any;
    applyOrgChangeIntent(stale, intent);
    expect(stale["ch-1"]).toMatchObject({ status: "accepted", edits: { reason: "now" } });
    // A refusal after that stale push still shows the typed edits.
    const refused = mutate({ ...st, orgProposalChanges: stale }, (d) => { d.orgIntents = []; });
    const back = run(refused as OrgSliceData, "revertOrgIntent", intent.id);
    expect(back.orgProposalChanges["ch-1"].edits).toEqual({ reason: "now" });
    // The echo carries decided_by: satisfied, dropped, and the server's status stands.
    const echoed = mutate(st, (d) => { d.orgProposalChanges["ch-1"] = { ...d.orgProposalChanges["ch-1"], status: "applied", decided_by: "u1" } as any; pruneOrgIntents(d); });
    expect(echoed.orgIntents).toEqual([]);
    expect(echoed.orgProposalChanges["ch-1"].status).toBe("applied");
    expect(echoed.orgIntentNotice).toBeNull();
    // Silence past the TTL: the row goes back to proposed, and the page is told.
    const later = Date.now() + ORG_INTENT_TTL_MS + 1;
    const aged = mutate(st, (d) => { pruneOrgIntents(d, later); });
    expect(aged.orgIntents).toEqual([]);
    expect(aged.orgProposalChanges["ch-1"].status).toBe("proposed");
    expect(aged.orgIntentNotice).toEqual({ text: 'Accepting "retire @ops" did not reach the server after a minute; the change is back to proposed.', at: later });
  });

  it("a refusal returns one notice per intent for the toast", () => {
    let st = staffing();
    st = run(st, "decideOrgProposalChange", "ch-1", "skip");
    const notices = dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: () => {} }, "decideOrgProposalChange", ["ch-1", "skip"]);
    expect(notices).toEqual(['Skipping "retire @ops" was refused; the change is back to proposed.']);
    expect(dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: () => {} }, "decideOrgProposalChange", ["other"])).toEqual([]);
  });

  it("the dispatch hook drops an intent only on a permanent refusal, and toasts it", async () => {
    // A transient exhaustion (a backend timeout) leaves the parked outbox row
    // to re-drive, so the intent must stay open or the ghost comes back while
    // the accept still lands later. Pinned at the source: the call sits
    // inside the permanent-error block and its notices reach a toast.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "..", "..", "hooks", "useEnsureDispatch.ts"), "utf8");
    const permanent = src.indexOf("if (isPermanentDispatchError(error)) {");
    const drop = src.indexOf("dropRejectedOrgIntent(useInboxStore.getState(), action, args)");
    expect(permanent).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(permanent);
    expect(src.slice(permanent, drop)).not.toMatch(/\n\s{6}}\n/); // no block closes between them
    expect(src).toMatch(/for \(const text of dropRejectedOrgIntent\(.*\)\) toast\.error\(text\)/);
  });

  it("a role's fields ride an intent: a heartbeat push cannot flicker a Resume, and a refusal puts the fields back at once", () => {
    const tree = clone();
    tree.roles[0].status = "paused";
    tree.roles[0].caps = { tokens_per_day: 100 };
    let st: OrgSliceData = { ...staffing(), orgTree: tree };
    st = run(st, "updateOrgRole", ROLE, { status: "active" });
    st = run(st, "updateOrgRole", ROLE, { caps: { tokens_per_day: 400 } });
    expect(st.orgTree!.roles[0].status).toBe("active");
    expect(st.orgTree!.roles[0].caps).toEqual({ tokens_per_day: 400 });
    // Two edits on one role are two intents, each with its own `from`.
    expect(st.orgIntents.map((i) => i.kind === "roleFields" && [Object.keys(i.fields)[0], i.from])).toEqual([["status", { status: "paused" }], ["caps", { caps: { tokens_per_day: 100 } }]]);
    // A push that still says paused (org.tree recomputes on any heartbeat) is replayed.
    const stalePush = clone();
    stalePush.roles[0].status = "paused";
    stalePush.roles[0].caps = { tokens_per_day: 100 };
    const stale = mergeOrgTree(stalePush, st.orgIntents);
    expect(stale.intents).toHaveLength(2);
    expect(stale.tree.roles[0].status).toBe("active");
    expect(stale.tree.roles[0].caps).toEqual({ tokens_per_day: 400 });
    // The echo agrees field by field: each intent clears on its own.
    const echo = clone();
    echo.roles[0].status = "active";
    echo.roles[0].caps = { tokens_per_day: 100 };
    const half = mergeOrgTree(echo, st.orgIntents);
    expect(half.intents.map((i) => i.kind === "roleFields" && Object.keys(i.fields)[0])).toEqual(["caps"]);
    expect(half.tree.roles[0].caps).toEqual({ tokens_per_day: 400 });
    // The rail refuses the Resume: status goes back to paused now, the caps edit stays.
    const reverted: string[] = [];
    const notices = dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "updateOrgRole", [ROLE, { status: "active" }]);
    expect(notices).toEqual(["Resuming the role was refused; put back."]);
    expect(reverted).toEqual([st.orgIntents[0].id]);
    st = run(st, "revertOrgIntent", reverted[0]);
    expect(st.orgTree!.roles[0].status).toBe("paused");
    expect(st.orgTree!.roles[0].caps).toEqual({ tokens_per_day: 400 });
    expect(st.orgIntents).toHaveLength(1);
    // A field that was unset goes back to unset.
    let st2: OrgSliceData = { ...staffing(), orgTree: clone() };
    expect(st2.orgTree!.roles[0].caps).toBeUndefined();
    st2 = run(st2, "updateOrgRole", ROLE, { caps: { hands_per_day: 2 } });
    st2 = run(st2, "revertOrgIntent", st2.orgIntents[0].id);
    expect(st2.orgTree!.roles[0].caps).toBeUndefined();
  });

  it("the line rides an intent: a tree push cannot snap the picker back, the per view echo drops it, a refusal restores, expiry says nothing", () => {
    // The tree never carries the slug (orgRoles.line does), so the replay is
    // the only thing that keeps the picker on the new value until the echo.
    let st: OrgSliceData = { ...staffing(), orgTree: clone() };
    st = run(st, "setRoleLine", ROLE, "feature");
    expect((st.orgTree!.roles[0] as any).line_workflow_slug).toBe("feature");
    expect(st.orgIntents.map((i) => i.kind === "line" && [i.role_id, i.slug, i.from])).toEqual([[ROLE, "feature", undefined]]);
    // A second pick replaces the first on the same subject.
    st = run(st, "setRoleLine", ROLE, "plan-autopilot");
    expect(st.orgIntents).toHaveLength(1);
    expect((st.orgTree!.roles[0] as any).line_workflow_slug).toBe("plan-autopilot");
    // Any push (a heartbeat) drops the field; the intent puts it back.
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.intents).toHaveLength(1);
    expect((stale.tree.roles[0] as any).line_workflow_slug).toBe("plan-autopilot");
    // The per view read echoes the slug: that is the acknowledgement.
    expect(lineIntentEchoed(st.orgIntents, ROLE, "feature")).toHaveLength(0);
    expect(lineIntentEchoed(st.orgIntents, ROLE, undefined)).toHaveLength(0);
    expect(lineIntentEchoed(st.orgIntents, ROLE, "plan-autopilot").map((i) => i.id)).toEqual([st.orgIntents[0].id]);
    st = run(st, "dropOrgIntent", st.orgIntents[0].id);
    expect(st.orgIntents).toHaveLength(0);
    // A refusal puts the row back to what it held (unset here) and says so.
    let st2: OrgSliceData = { ...staffing(), orgTree: clone() };
    st2 = run(st2, "setRoleLine", ROLE, "feature");
    const reverted: string[] = [];
    const notices = dropRejectedOrgIntent({ orgIntents: st2.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "setRoleLine", [ROLE, "feature"]);
    expect(notices).toEqual(["Setting the line to feature was refused; put back."]);
    st2 = run(st2, "revertOrgIntent", reverted[0]);
    expect((st2.orgTree!.roles[0] as any).line_workflow_slug).toBeUndefined();
    // Ageing out is not evidence the write failed: no notice, and the merge
    // leaves the server's row as pushed.
    let st3: OrgSliceData = { ...staffing(), orgTree: clone() };
    st3 = run(st3, "setRoleLine", ROLE, "feature");
    expect(orgIntentNoticeText(st3.orgIntents[0], "expired")).toBe("");
    const aged = mergeOrgTree(clone(), st3.orgIntents, Date.now() + ORG_INTENT_TTL_MS + 1);
    expect(aged.intents).toHaveLength(0);
    expect((aged.tree.roles[0] as any).line_workflow_slug).toBeUndefined();
  });

  it("a retire rides an intent: a stale push replays it and the echo clears it", () => {
    let st: OrgSliceData = { ...staffing(), orgTree: clone() };
    const meTotal = st.orgTree!.people[0].total;
    st = run(st, "retireOrgRole", ROLE);
    expect(st.orgTree!.roles).toHaveLength(0);
    expect(st.orgIntents.map((i) => i.kind)).toEqual(["retireRole"]);
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.intents).toHaveLength(1);
    expect(stale.tree.roles).toHaveLength(0);
    expect(stale.tree.people[0].total).toBe(meTotal + ORG_FIXTURE.roles[0].total);
    const echo = clone();
    echo.roles = [];
    expect(mergeOrgTree(echo, st.orgIntents).intents).toHaveLength(0);
    const notices = dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: () => {} }, "retireOrgRole", [ROLE]);
    expect(notices).toEqual(["Retiring @growth was refused; the role is back."]);
  });

  it("a hire puts a stub on the tree that a stale push keeps, the echo replaces, and a refusal removes", () => {
    const input = { host_user_id: ME, client_id: "orgrolestub-chief-1", team_id: ORG_FIXTURE.workspace.id };
    let st = staffing();
    st = run(st, "staffChiefOfStaff", input);
    expect(st.orgTree!.roles.some((r) => r._id === input.client_id && r.handle === "chief-of-staff")).toBe(true);
    expect(st.orgIntents.map((i) => i.kind)).toEqual(["staff"]);
    // Idempotent: a second click adds nothing.
    st = run(st, "staffChiefOfStaff", { ...input, client_id: "orgrolestub-chief-2" });
    expect(st.orgTree!.roles.filter((r) => r.handle === "chief-of-staff")).toHaveLength(1);
    // A push without the chief keeps the stub.
    const stale = mergeOrgTree(clone(), st.orgIntents);
    expect(stale.intents).toHaveLength(1);
    expect(stale.tree.roles.some((r) => r._id === input.client_id)).toBe(true);
    // The echo names the real row: intent gone, stub gone with the replaced tree.
    const echo = clone();
    echo.roles.push({ ...echo.roles[0], _id: "real-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff" });
    const settled = mergeOrgTree(echo, st.orgIntents);
    expect(settled.intents).toHaveLength(0);
    expect(settled.tree).toBe(echo);
    // The rail refuses the hire: the stub comes off the draft's tree.
    const reverted: string[] = [];
    dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "staffChiefOfStaff", [input]);
    expect(reverted).toHaveLength(1);
    st = run(st, "revertOrgIntent", reverted[0]);
    expect(st.orgTree!.roles.some((r) => r.handle === "chief-of-staff")).toBe(false);
    expect(st.orgIntents).toEqual([]);
  });

  it("satisfaction reads the tree, not the intent", () => {
    const tree = clone();
    expect(orgIntentSatisfied(tree, { kind: "moveRole", id: "a", role_id: ROLE, reports_to: { kind: "user", user_id: ME }, at: 0 })).toBe(true);
    expect(orgIntentSatisfied(tree, { kind: "moveRole", id: "a", role_id: ROLE, reports_to: { kind: "user", user_id: SAM }, at: 0 })).toBe(false);
    expect(orgIntentSatisfied(tree, { kind: "moveRole", id: "a", role_id: "gone", reports_to: { kind: "user", user_id: SAM }, at: 0 })).toBe(true);
  });

  it("retiring a role carries its unseen sessions to the parent person's counts", () => {
    const tree = clone();
    const role = tree.roles[0];
    role.total = 30; // 8 drawn, 22 beyond the top N
    role.counts = { ...role.counts, idle: (role.counts.idle ?? 0) + 22 };
    const meTotal = tree.people[0].total;
    const st = run({ orgTree: tree, orgIntents: [] }, "retireOrgRole", ROLE);
    expect(st.orgTree!.roles).toHaveLength(0);
    // 7 drawn rows (the fixture role holds 7 of 8) re-home by owner, the
    // remaining 23 land on the parent person: the header total is unchanged.
    expect(st.orgTree!.people[0].total).toBe(meTotal + 30);
  });
});
