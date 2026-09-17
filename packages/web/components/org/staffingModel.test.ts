import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_BIG_PROPOSAL, ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import {
  bottleneckRoles,
  changeEdits,
  changeFields,
  changeLine,
  changeNodeId,
  changeTenure,
  collectHealthFlags,
  findChiefOfStaff,
  groupChanges,
  isSyncChange,
  pickProposal,
  proposalParam,
  proposalProgress,
  proposalRefInContext,
  recordsInLine,
  remainingChanges,
  resolveProposalAuthor,
  roleChangeEdits,
  roleChangeInitial,
  spanOfControl,
  staffingMode,
  syncEvidence,
  syncGroupSummary,
  tenureLine,
  SYNC_CARD_THRESHOLD,
  evidenceBucket,
  planCarriedTasks,
  reviewRunState,
  REVIEW_TTL_MS,
  REVIEW_START_GRACE_MS,
} from "./staffingModel";
import type { OrgTree } from "./orgTypes";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { ORG_CHANGE_APPLY_RANK } from "@codecast/shared/contracts/orgProposal";

const P = ORG_STAFFING_FIXTURE_PROPOSAL;
const H = ORG_STAFFING_FIXTURE_HEALTH;

describe("proposal progress and grouping", () => {
  test("N of M decided counts every change no longer decidable", () => {
    expect(proposalProgress(P)).toEqual({ decided: 2, total: 8, remaining: 6, applied: 0, skipped: 1, failed: 0, fromCounts: false });
  });

  test("a failed change is still to decide, as the server sees it", async () => {
    const { isDecidable } = await import("./staffingModel");
    expect(["proposed", "failed"].map(isDecidable)).toEqual([true, true]);
    expect(["accepted", "applied", "skipped"].map(isDecidable)).toEqual([false, false, false]);
    // One failed row among the eight: the header says 2 of 8, and the failed
    // row is in the remaining list so Accept all retries it.
    const withFailed = { ...P, changes: P.changes.map((c) => c._id === "fixture-change-4" ? { ...c, status: "failed" as const, applied_note: "handle clash" } : c) };
    expect(proposalProgress(withFailed)).toMatchObject({ decided: 2, total: 8, remaining: 6, failed: 1 });
    expect(remainingChanges(withFailed).map((c) => c._id)).toContain("fixture-change-4");
    // Every row failed: nothing is decided, everything remains.
    const allFailed = { ...P, changes: P.changes.map((c) => ({ ...c, status: "failed" as const })) };
    expect(proposalProgress(allFailed)).toMatchObject({ decided: 0, remaining: 8, failed: 8 });
  });

  test("before the change rows land, the list row's counts stand in and the failed ones come back out", () => {
    const listRow = { changes: [], counts: { total: 12, decided: 3, applied: 1, failed: 1, skipped: 1 } };
    expect(proposalProgress(listRow)).toEqual({ decided: 2, total: 12, remaining: 10, applied: 1, skipped: 1, failed: 1, fromCounts: true });
    expect(proposalProgress({ changes: [] })).toEqual({ decided: 0, total: 0, remaining: 0, applied: 0, skipped: 0, failed: 0, fromCounts: false });
  });

  test("remaining changes come back in apply order, not seq order", () => {
    // seq order is role, role, projects, budget, routine, project_meta, plan
    // status, task status; the accepted projects change and the skipped
    // routine drop out, and the shared apply order puts the records first
    // (S9), then roles, then charters (they name an owner role), then budget.
    // The two record kinds' relative order is the contract's (the cascade
    // session moved tasks ahead of plans); the pane only cares that both lead.
    const kinds = remainingChanges(P).map((c) => c.change.kind);
    expect(kinds.slice(0, 2).sort()).toEqual(["plan_status", "task_status"]);
    expect(kinds.slice(2)).toEqual(["role", "role", "project_meta", "budget"]);
  });

  test("groups follow the apply order: the records first as one group, then one group per kind", () => {
    const groups = groupChanges(P.changes);
    expect(groups.map((g) => `${g.kind}:${g.changes.length}`)).toEqual(["sync:2", "projects:1", "role:2", "project_meta:1", "budget:1", "routine:1"]);
    expect(groups[0]).toMatchObject({ sync: true, label: "Records to bring up to date" });
    expect(groups[1].sync).toBe(false);
    expect(groups[2].label).toBe("New standing agents");
  });

  test("the records group counts distinct records, and each row carries its evidence line (S9)", () => {
    const sync = groupChanges(P.changes)[0].changes;
    const plan = sync.find((c) => c.change.kind === "plan_status")!;
    expect(recordsInLine(sync)).toBe(2);
    // The same plan named twice is one record.
    expect(recordsInLine([...sync, { ...plan, _id: "dup" }])).toBe(2);
    expect(syncEvidence(plan.change)).toBe("Every task closed 19 days ago; the two bound sessions ended with done handoffs.");
    expect(syncEvidence(P.changes[0].change)).toBeNull();
    expect(sync.every((c) => isSyncChange(c.change))).toBe(true);
    expect(isSyncChange(P.changes[3].change)).toBe(false);
    // The edit form offers the record's status as a closed set.
    const fields = changeFields(plan.change);
    expect(fields.find((f) => f.key === "status")).toMatchObject({ kind: "select", value: "done", options: ["done", "abandoned", "active"] });
    expect(fields.find((f) => f.key === "reason")?.label).toBe("evidence");
    expect(changeEdits(plan.change, fields.map((f) => f.key === "status" ? { ...f, value: "abandoned" } : f))).toEqual({ status: "abandoned" });
  });

  test("a role change carries its tenure (S10), edits laid over", () => {
    expect(changeTenure(P.changes[0])).toEqual({ kind: "standing" });
    expect(tenureLine(changeTenure(P.changes[0]))).toBe("standing");
    expect(tenureLine(changeTenure(P.changes[1]))).toBe("program · ends with pl-88, then review");
    expect(changeTenure({ ...P.changes[0], edits: { tenure: { kind: "program", ends: { date: Date.UTC(2026, 11, 1) }, then: "retire" } } })).toMatchObject({ kind: "program" });
    // A date reads as a person says it; built relative to now so the year stays true.
    const thisYear = new Date().getUTCFullYear();
    expect(tenureLine(changeTenure({ ...P.changes[0], edits: { tenure: { kind: "program", ends: { date: Date.UTC(thisYear, 11, 1) }, then: "retire" } } }))).toBe("program · ends Dec 1, then retire");
    expect(changeTenure(P.changes[3])).toBeNull();
    expect(tenureLine(null)).toBe("");
    // The hire dialog's prefill and its edits round trip tenure and avatar.
    expect(roleChangeInitial(P.changes[1], ORG_FIXTURE)).toMatchObject({ tenure: { kind: "program", ends: { plan: "pl-88" }, then: "review" } });
    const edits = roleChangeEdits({ name: "Content Lead", handle: "content", tenure: { kind: "standing" }, avatar: "avatar-03", touched: { scope: false, reports_to: false } }, ORG_FIXTURE, "fixture-user-me");
    expect(edits).toMatchObject({ tenure: { kind: "standing" }, avatar: "avatar-03" });
    expect(Object.keys(edits)).not.toContain("scope");
  });

  test("every kind reads as one line", () => {
    // The words are the shared describer's (the CLI walk and the ghost chips
    // read the same line); the pane only sentence cases them.
    expect(changeLine(P.changes[0].change)).toBe("Create role Head of Platform @platform reporting to me over Platform (standing)");
    expect(changeLine(P.changes[1].change)).toBe("Create role Content Lead @content reporting to @growth over pl-88 (program · ends with pl-88, then review)");
    expect(changeLine(P.changes[6].change)).toBe("Mark plan pl-61 done");
    expect(changeLine(P.changes[7].change)).toBe("Mark task ct-4102 done");
    expect(changeLine(P.changes[2].change)).toBe("Create project Platform");
    expect(changeLine(P.changes[3].change)).toBe("Budget @growth tokens 800000/day");
    expect(changeLine(P.changes[4].change)).toBe("Routine on @growth: Weekly growth review every 7d");
    expect(changeLine(P.changes[5].change)).toBe("Charter Growth owner @growth p1: Double organic signups by December");
    expect(changeLine({ kind: "move", handle: "content", reports_to: "@growth" })).toBe("Move @content under @growth");
    expect(changeLine({ kind: "retire", handle: "ops" })).toBe("Retire @ops");
    expect(changeLine({ kind: "trust", handle: "growth", trust: "decide" })).toBe("Trust @growth to decide");
  });

  test("a change on an existing role focuses that node; a ghost has no node", () => {
    expect(changeNodeId(P.changes[3].change, ORG_FIXTURE)).toBe("role:fixture-role-growth");
    expect(changeNodeId(P.changes[0].change, ORG_FIXTURE)).toBeNull();
    expect(changeNodeId(P.changes[2].change, ORG_FIXTURE)).toBeNull();
  });
});

describe("pane mode", () => {
  const withChief: OrgTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff" }] };

  test("an open proposal wins over everything", () => {
    expect(staffingMode(ORG_FIXTURE, P)).toBe("proposal");
    expect(staffingMode(withChief, P)).toBe("proposal");
  });

  test("no proposal and a chief of staff shows the health summary", () => {
    expect(findChiefOfStaff(withChief)?.short_id).toBe("or-9");
    expect(staffingMode(withChief, null)).toBe("health");
  });

  test("no proposal and no chief of staff shows the hire buttons", () => {
    expect(findChiefOfStaff(ORG_FIXTURE)).toBeNull();
    expect(staffingMode(ORG_FIXTURE, null)).toBe("no_chief");
    expect(staffingMode(null, null)).toBe("no_chief");
  });

  test("a retired chief of staff does not count", () => {
    const retired: OrgTree = { ...withChief, roles: withChief.roles.map((r) => r.handle === "chief-of-staff" ? { ...r, status: "retired" as const } : r) };
    expect(staffingMode(retired, null)).toBe("no_chief");
  });
});

describe("health summary", () => {
  test("flags come back worst first, each pointing at its node", () => {
    const rows = collectHealthFlags(H, ORG_FIXTURE);
    expect(rows.map((r) => r.flag.severity)).toEqual(["blocker", "warn", "warn", "warn", "info"]);
    expect(rows[0].subject).toEqual({ kind: "company" });
    const growth = rows.find((r) => r.subject.kind === "role");
    expect(growth?.subject).toMatchObject({ kind: "role", handle: "growth", nodeId: "role:fixture-role-growth" });
  });

  test("span of control reads every person against the model's limit", () => {
    const span = spanOfControl(H, ORG_FIXTURE);
    expect(span.map((s) => [s.name, s.direct_roles, s.wide])).toEqual([["Ashot Petrosian", 1, false], ["Samvit Jain", 0, false]]);
    expect(span[0].limit).toBe(7);
    const wide = spanOfControl({ ...H, people: [{ ...H.people[0], direct_roles: 9 }, H.people[1]] }, ORG_FIXTURE);
    expect(wide[0].wide).toBe(true);
  });

  test("span falls back to the tree when health has no row for a person", () => {
    const span = spanOfControl(null, ORG_FIXTURE);
    expect(span[0]).toMatchObject({ name: "Ashot Petrosian", direct_roles: 1 });
  });

  test("bottleneck roles carry only their warn and blocker flags", () => {
    const rows = bottleneckRoles(H);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ handle: "growth", worst: "warn" });
    expect(rows[0].flags.map((f) => f.code)).toEqual(["overloaded", "cap_hit"]);
    expect(bottleneckRoles(null)).toEqual([]);
  });
});

describe("the ?proposal= parameter", () => {
  test("reads op-N in either case and rejects anything else", () => {
    expect(proposalParam("?proposal=op-7")).toBe("op-7");
    expect(proposalParam("proposal=OP-12&x=1")).toBe("op-12");
    expect(proposalParam("?proposal=ds-3")).toBeNull();
    expect(proposalParam("")).toBeNull();
    expect(proposalParam(null)).toBeNull();
  });

  test("picks the named proposal, never another one in its place; unnamed, the newest open one", () => {
    const older = { ...P, _id: "p-old", short_id: "op-3", created_at: P.created_at - 1000 };
    const resolved = { ...P, _id: "p-res", short_id: "op-5", status: "resolved" as const, created_at: P.created_at + 5000 };
    expect(pickProposal([older, P, resolved], "op-3")?.short_id).toBe("op-3");
    // A link to a proposal outside these rows (another workspace, or beyond
    // the list cap) opens nothing: the link line names where it is.
    expect(pickProposal([older, P, resolved], "op-99")).toBeNull();
    expect(pickProposal([older, P, resolved], null)?.short_id).toBe("op-7");
    expect(pickProposal([resolved], null)).toBeNull();
  });
});

describe("flags a proposal addresses", () => {
  test("only role flags on a handle some change touches, subject or named parent", async () => {
    const { relatedFlags, changeHandles } = await import("./staffingModel");
    const flags = collectHealthFlags(H, ORG_FIXTURE);
    // The fixture's changes budget and routine @growth and charter Growth with owner @growth.
    expect(relatedFlags(flags, P.changes).map((r) => `${r.flag.code}@${(r.subject as any).handle}`)).toEqual(["overloaded@growth", "cap_hit@growth", "review_stall@growth"]);
    expect(relatedFlags(flags, [])).toEqual([]);
    expect(relatedFlags(flags, [P.changes[2]])).toEqual([]); // a projects change names no role
    expect(changeHandles({ kind: "move", handle: "content", reports_to: "@growth" })).toEqual(["content", "growth"]);
    expect(changeHandles({ kind: "role", name: "X", handle: "x", reports_to: "me" })).toEqual(["x"]);
  });
});

describe("what a list answer is authoritative for", () => {
  test("a team's rows by team_id; the personal list is every row with no team", async () => {
    const { proposalListScope } = await import("./staffingModel");
    const team = proposalListScope("team-a");
    expect(team({ team_id: "team-a" })).toBe(true);
    expect(team({ team_id: "team-b" })).toBe(false);
    expect(team({})).toBe(false);
    const personal = proposalListScope(undefined);
    expect(personal({})).toBe(true);
    expect(personal({ team_id: "team-a" })).toBe(false);
  });

  test("a null list answer is a refusal, not an empty workspace: the push is skipped, so nothing is pruned", async () => {
    // orgProposals.list answers null whenever requireWorkspaceCaller fails
    // (no identity yet on a fresh subscription, a token refresh beat, a team
    // the viewer left). Turned into [] it would be an authoritative empty set
    // and plant a durable exclude tombstone on every proposal in scope.
    const { selectList } = await import("../../hooks/useSyncOrgProposals");
    expect(selectList(null)).toBeUndefined();
    expect(selectList(undefined)).toBeUndefined();
    expect(selectList({})).toBeUndefined();
    expect(selectList({ proposals: [] })).toEqual([]);
    expect(selectList({ proposals: [{ _id: "a" }] })).toEqual([{ _id: "a" }]);
  });

  test("both feeders prune what their answer no longer carries", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "..", "..", "hooks", "useSyncOrgProposals.ts"), "utf8");
    expect(src).toMatch(/pruneAbsentScope: proposalListScope\(teamId\)/);
    expect(src).toMatch(/"orgProposalChanges", changes \?\? \[\], \{ pruneAbsentScope/);
  });
});

describe("the ?compose= parameter", () => {
  test("reads the decoded text and ignores an empty one", async () => {
    const { composeParam } = await import("./staffingModel");
    expect(composeParam("?compose=draft%20a%20charter%20for%20Growth")).toBe("draft a charter for Growth");
    expect(composeParam("proposal=op-7&compose=hello")).toBe("hello");
    expect(composeParam("?compose=%20%20")).toBeNull();
    expect(composeParam("?proposal=op-7")).toBeNull();
    expect(composeParam(null)).toBeNull();
  });
});

describe("inline edit of a change", () => {
  test("fields flatten one level and edits come back nested, only where changed", async () => {
    const { changeEdits, changeFields } = await import("./staffingModel");
    const budget = P.changes[3].change;
    const fields = changeFields(budget);
    expect(fields).toEqual([
      { key: "handle", label: "handle", kind: "text", value: "growth" },
      { key: "caps.tokens_per_day", label: "caps tokens per day", kind: "number", value: "800000" },
    ]);
    expect(changeEdits(budget, fields)).toEqual({});
    expect(changeEdits(budget, fields.map((f) => f.key === "caps.tokens_per_day" ? { ...f, value: "600000" } : f))).toEqual({ caps: { tokens_per_day: 600000 } });
    const meta = P.changes[5].change;
    const metaFields = changeFields(meta);
    expect(metaFields.find((f) => f.key === "success_metrics")).toEqual({ key: "success_metrics", label: "success metrics", kind: "list", value: "organic signups per week, AI citation count" });
    expect(changeEdits(meta, metaFields.map((f) => f.key === "success_metrics" ? { ...f, value: "signups, citations" } : f))).toEqual({ success_metrics: ["signups", "citations"] });
  });
});

describe("the hire dialog as an edit form for a role change", () => {
  test("the dialog's output round trips into the contract's shape and stays a valid change", async () => {
    const { roleChangeEdits, roleChangeInitial, orgParentRefAsProposal } = await import("./staffingModel");
    const { editedOrgChange, orgChangeError } = await import("@codecast/shared/contracts/orgProposal");
    const change = { kind: "role" as const, name: "Head of Platform", handle: "platform", reports_to: "Samvit Jain", scope: { projects: ["Platform"] }, caps: { tokens_per_day: 400_000 } };
    const row = { _id: "c1", proposal_id: "p", seq: 1, change, rationale: "r", evidence: [], status: "proposed" as const };
    // The prefill resolves the proposal's parent against the tree and hands
    // the scope refs through for the form to tick.
    expect(roleChangeInitial(row, ORG_FIXTURE)).toEqual({ name: "Head of Platform", handle: "platform", caps: { tokens_per_day: 400_000 }, scope: { projects: ["Platform"] }, reports_to: { kind: "user", user_id: "fixture-user-sam" } });
    // Edits already made ride into the prefill.
    expect(roleChangeInitial({ ...row, edits: { name: "Platform Lead", reports_to: "@growth" } }, ORG_FIXTURE)).toMatchObject({ name: "Platform Lead", reports_to: { kind: "role", role_id: "fixture-role-growth" } });
    // Submit: ids and parent refs become refs and a string.
    const edits = roleChangeEdits({ name: "Platform Lead", handle: "platform-lead", charter: "Owns the platform.", caps: { hands_per_day: 4, wakes_per_day: 40, tokens_per_day: 800_000 }, scope: { project_ids: ["projects_abc"], plan_ids: ["plans_xyz"] }, reports_to: { kind: "role", role_id: "fixture-role-growth" } }, ORG_FIXTURE, "fixture-user-me");
    expect(edits).toEqual({ name: "Platform Lead", handle: "platform-lead", charter: "Owns the platform.", caps: { hands_per_day: 4, wakes_per_day: 40, tokens_per_day: 800_000 }, scope: { projects: ["projects_abc"], plans: ["plans_xyz"] }, reports_to: "@growth" });
    const merged = editedOrgChange(change, edits);
    expect(orgChangeError(merged)).toBeNull();
    expect(merged).toMatchObject({ kind: "role", scope: { projects: ["projects_abc"], plans: ["plans_xyz"] }, reports_to: "@growth" });
    // The deciding person is "me"; another member is their id; a role with no live row is its id.
    expect(orgParentRefAsProposal(ORG_FIXTURE, { kind: "user", user_id: "fixture-user-me" }, "fixture-user-me")).toBe("me");
    expect(orgParentRefAsProposal(ORG_FIXTURE, { kind: "user", user_id: "fixture-user-sam" }, "fixture-user-me")).toBe("fixture-user-sam");
    expect(orgParentRefAsProposal(ORG_FIXTURE, { kind: "role", role_id: "chg-9" }, "fixture-user-me")).toBe("chg-9");
    expect(roleChangeInitial({ ...row, change: { kind: "retire", handle: "growth" } }, ORG_FIXTURE)).toBeUndefined();
    // An untouched scope or parent is not sent: a ref the form could not
    // resolve, or a parent the same proposal creates, survives as proposed.
    const untouched = roleChangeEdits({ name: "Platform Lead", handle: "platform-lead", caps: { hands_per_day: 4, wakes_per_day: 40, tokens_per_day: 800_000 }, scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: "fixture-user-me" }, touched: { scope: false, reports_to: false } }, ORG_FIXTURE, "fixture-user-me");
    expect(untouched).toEqual({ name: "Platform Lead", handle: "platform-lead", caps: { hands_per_day: 4, wakes_per_day: 40, tokens_per_day: 800_000 } });
    expect(editedOrgChange(change, untouched)).toMatchObject({ scope: { projects: ["Platform"] }, reports_to: "Samvit Jain" });
    const scopeOnly = roleChangeEdits({ name: "R", handle: "rr", scope: { project_ids: ["projects_abc"], plan_ids: [] }, reports_to: { kind: "user", user_id: "fixture-user-me" }, touched: { scope: true, reports_to: false } }, ORG_FIXTURE, "fixture-user-me");
    expect(scopeOnly).toEqual({ name: "R", handle: "rr", scope: { projects: ["projects_abc"], plans: [] } });
  });
});

describe("a link into another workspace", () => {
  test("resolves open, foreign, unreadable and loading", async () => {
    const { resolveProposalLink, proposalWorkspace, orgPreviewEnabled } = await import("./staffingModel");
    const codecast = { kind: "team" as const, id: "fixture-team" };
    const union = { kind: "team" as const, id: "team-union" };
    expect(proposalWorkspace(P)).toEqual(codecast);
    expect(proposalWorkspace({ scope_user_id: "u1" })).toEqual({ kind: "user", id: "u1" });
    expect(resolveProposalLink(null, [P], union, { ready: false, missing: false })).toEqual({ kind: "open" });
    expect(resolveProposalLink("op-7", [P], codecast, { ready: true, missing: false })).toEqual({ kind: "open" });
    expect(resolveProposalLink("op-7", [P], union, { ready: true, missing: false })).toMatchObject({ kind: "foreign", shortId: "op-7", workspace: codecast });
    expect(resolveProposalLink("op-7", [P], { kind: "user", id: "me" }, { ready: true, missing: false })).toMatchObject({ kind: "foreign" });
    expect(resolveProposalLink("op-99", [P], union, { ready: true, missing: true })).toEqual({ kind: "unreadable", shortId: "op-99" });
    expect(resolveProposalLink("op-99", [P], union, { ready: false, missing: false })).toEqual({ kind: "loading", shortId: "op-99" });
    expect(resolveProposalLink("op-99", [P], union, { ready: true, missing: false })).toEqual({ kind: "loading", shortId: "op-99" });
  });

  test("the DEV preview needs the flag in the live URL", async () => {
    const { orgPreviewEnabled } = await import("./staffingModel");
    expect(orgPreviewEnabled("?preview=1", true)).toBe(true);
    expect(orgPreviewEnabled("?proposal=op-4", true)).toBe(false);
    expect(orgPreviewEnabled("?preview=1", false)).toBe(false);
    expect(orgPreviewEnabled("", true)).toBe(false);
  });
});

describe("the org feeders follow the workspace pointer", () => {
  // A workspace switch (hooks/useSwitchWorkspace) writes clientState.ui
  // .active_team_id; every org feeder must key its query on that pointer so
  // /org re-scopes in the same tick. A feeder that read anything else would
  // keep the old team after a switch.
  test("tree, health and proposals feeders read clientState.ui.active_team_id", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["useSyncOrgTree.ts", "useSyncOrgHealth.ts", "useSyncOrgProposals.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "..", "hooks", file), "utf8");
      expect(src).toMatch(/clientState\.ui\?\.active_team_id/);
      expect(src).toMatch(/team_id: activeTeamId/);
    }
  });
});

describe("where a proposal came from (S15)", () => {
  test("a session author reads as its title and short id, from the server's enrichment first, else the store row, else the bare kind", () => {
    expect(resolveProposalAuthor({ kind: "session", id: "c1", name: "Org review", short_id: "jx7rev1" }, {})).toEqual({ kind: "session", sessionId: "c1", title: "Org review", shortId: "jx7rev1" });
    expect(resolveProposalAuthor({ kind: "session", id: "c1" }, { session: { title: "From the store", short_id: "jx7sto1" } })).toEqual({ kind: "session", sessionId: "c1", title: "From the store", shortId: "jx7sto1" });
    expect(resolveProposalAuthor({ kind: "session", id: "c1" }, {})).toEqual({ kind: "session", sessionId: "c1", title: "a session", shortId: null });
  });

  test("a role author reads as its name, handle and avatar and opens its scope page", () => {
    const view = resolveProposalAuthor({ kind: "role", id: "r1", name: "Chief of Staff", short_id: "or-9", handle: "chief-of-staff" }, {});
    expect(view).toMatchObject({ kind: "role", roleId: "r1", name: "Chief of Staff", handle: "chief-of-staff", href: "/org/or-9" });
    expect(AVATAR_KEYS).toContain((view as { avatar: string }).avatar);
    // The tree's row fills what the server left out; a chosen avatar wins over the handle's default.
    const chosen = AVATAR_KEYS[AVATAR_KEYS.length - 1];
    const fromTree = resolveProposalAuthor({ kind: "role", id: "r1" }, { role: { name: "Growth", handle: "growth", short_id: "or-1", avatar: chosen } });
    expect(fromTree).toMatchObject({ name: "Growth", handle: "growth", href: "/org/or-1", avatar: chosen });
    // Nothing known: still a pill, no link.
    expect(resolveProposalAuthor({ kind: "role", id: "r1" }, {})).toMatchObject({ name: "a role", href: null });
    expect(resolveProposalAuthor({ kind: "user", id: "u1", name: "Sam" }, {})).toEqual({ kind: "user", name: "Sam" });
  });

  test("the queue card finds its proposal in the decision's context", () => {
    expect(proposalRefInContext("Summary.\n\n[Open op-12 on the org page](https://codecast.sh/org?proposal=op-12)\n\n- create role")).toBe("op-12");
    expect(proposalRefInContext("[Open](/org?proposal=OP-3)")).toBe("op-3");
    expect(proposalRefInContext("no link here")).toBeNull();
    expect(proposalRefInContext(undefined)).toBeNull();
  });
});

describe("a records group at scale (S9, the first real review)", () => {
  const BIG = ORG_STAFFING_FIXTURE_BIG_PROPOSAL;

  test("the fixture is the real review's shape: 129 changes, 111 records, the records group first", () => {
    expect(BIG.changes.length).toBe(129);
    const groups = groupChanges(BIG.changes);
    expect(groups[0]).toMatchObject({ kind: "sync", sync: true });
    expect(groups[0].changes.length).toBe(111);
    expect(groups[0].changes.length).toBeGreaterThan(SYNC_CARD_THRESHOLD);
    // The order between kinds is the contract's (other sessions tune it); the
    // pane's own claims are the records first, and one group per kind.
    const rest = (["file", "role", "project_meta", "scope", "routine", "adopt"] as const).slice().sort((a, b) => ORG_CHANGE_APPLY_RANK[a] - ORG_CHANGE_APPLY_RANK[b]);
    const sizes: Record<string, number> = { file: 10, role: 1, project_meta: 4, scope: 1, routine: 1, adopt: 1 };
    expect(groups.map((g) => `${g.kind}:${g.changes.length}`)).toEqual(["sync:111", ...rest.map((k) => `${k}:${sizes[k]}`)]);
  });

  test("the summary counts by kind, files carried tasks under their plan, and ranks the consequential lines first", () => {
    const sync = groupChanges(BIG.changes)[0].changes;
    const summary = syncGroupSummary(sync);
    expect(summary.total).toBe(111);
    expect(summary.remaining).toBe(111);
    expect(summary.countLine).toBe("103 tasks, 8 plans");
    expect(summary.byKind.map((k) => [k.kind, k.count])).toEqual([["task_status", 103], ["plan_status", 8]]);
    // Three plans carry 4, 3 and 2 tasks: those nine rows leave the list and nest.
    expect(Object.values(summary.nested).map((n) => n.length).sort()).toEqual([2, 3, 4]);
    expect(summary.rows.length).toBe(111 - 9);
    expect(summary.rows.some((c) => c.change.kind === "task_status" && (c.change as { task: string }).task === "ct-9001")).toBe(false);
    expect(planCarriedTasks(sync.find((c) => c._id === "fixture-big-1")!.change)).toEqual(["ct-9001", "ct-9002", "ct-9003", "ct-9004"]);
    expect(planCarriedTasks(sync.find((c) => c._id === "fixture-big-9")!.change)).toEqual([]);
    // Plans before tasks; the plan carrying the most tasks first.
    expect(summary.top.length).toBe(3);
    expect(summary.top.map((c) => c.change.kind)).toEqual(["plan_status", "plan_status", "plan_status"]);
    expect(summary.top[0]._id).toBe("fixture-big-1");
    expect(summary.top[1]._id).toBe("fixture-big-2");
    // The evidence summary sums the reasons into a few words, largest first.
    expect(summary.evidence[0].count).toBeGreaterThanOrEqual(summary.evidence[1].count);
    expect(summary.evidence.reduce((n, e) => n + e.count, 0)).toBe(111);
    expect(summary.evidence.map((e) => e.label)).toContain("commits landed");
    expect(summary.evidence.map((e) => e.label)).toContain("under a finished plan");
  });

  test("evidence buckets read the analyzer's own words", () => {
    expect(evidenceBucket("the feature is on main: commit 602617b42")).toBe("commits landed");
    expect(evidenceBucket("under pl-293, a plan already marked done; a task under a finished plan is finished")).toBe("under a finished plan");
    expect(evidenceBucket("Its session ended with a done handoff 14 days ago")).toBe("its session ended");
    expect(evidenceBucket("Every task closed 12 days ago.")).toBe("every task closed");
    expect(evidenceBucket("No session and no commit naming it for 40 days.")).toBe("no activity");
    expect(evidenceBucket("")).toBe("other evidence");
  });

  test("a small records group is rows, not a card; decided rows drop out of remaining", () => {
    const small = groupChanges(P.changes)[0].changes;
    expect(small.length).toBeLessThanOrEqual(SYNC_CARD_THRESHOLD);
    const s = syncGroupSummary(small.map((c, i) => i === 0 ? { ...c, status: "applied" as const } : c));
    expect(s).toMatchObject({ total: 2, remaining: 1 });
    expect(s.byKind.map((k) => `${k.count} ${k.word}`).sort()).toEqual(["1 plan", "1 task"]);
    expect(s.nested).toEqual({});
  });
});

describe("a review the page started (Propose an org now)", () => {
  const T = 1_800_000_000_000;
  const run = { since: T, session_id: "conv-1", workspace: "team-1" };

  test("reviewing while young, in its own workspace, with nothing landed", () => {
    expect(reviewRunState(run, T + 60_000, "team-1", [], null)).toBe("reviewing");
    expect(reviewRunState(null, T, "team-1", [], null)).toBe("none");
    expect(reviewRunState(run, T + 60_000, "team-2", [], null)).toBe("none");
    expect(reviewRunState(run, T + 60_000, null, [], null)).toBe("none");
    expect(reviewRunState(run, T + REVIEW_TTL_MS, "team-1", [], null)).toBe("none");
  });

  test("a proposal of any status since the start ends it; an older one does not", () => {
    expect(reviewRunState(run, T + 60_000, "team-1", [{ created_at: T + 30_000 }], null)).toBe("none");
    expect(reviewRunState(run, T + 60_000, "team-1", [{ created_at: T - 1 }], null)).toBe("reviewing");
  });

  test("a session that stopped with nothing posted is ended, after the start grace", () => {
    // A fresh session reads as idle for a moment before its first turn.
    expect(reviewRunState(run, T + 30_000, "team-1", [], { is_idle: true })).toBe("reviewing");
    expect(reviewRunState(run, T + REVIEW_START_GRACE_MS, "team-1", [], { is_idle: true })).toBe("ended");
    expect(reviewRunState(run, T + REVIEW_START_GRACE_MS, "team-1", [], { status: "completed" })).toBe("ended");
    expect(reviewRunState(run, T + REVIEW_START_GRACE_MS, "team-1", [], { is_idle: false, status: "active" })).toBe("reviewing");
    // A session row this window does not hold says nothing either way.
    expect(reviewRunState(run, T + REVIEW_START_GRACE_MS, "team-1", [], null)).toBe("reviewing");
    // Ended, then the proposal lands late: nothing to say.
    expect(reviewRunState(run, T + REVIEW_START_GRACE_MS, "team-1", [{ created_at: T + 5 }], { is_idle: true })).toBe("none");
  });
});
