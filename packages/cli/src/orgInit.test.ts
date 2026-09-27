import { describe, expect, test } from "bun:test";
import { CHIEF_OF_STAFF_HANDLE, registerOrgInitCommands } from "./orgInit";
import { Command } from "commander";
import { apply, applyStack, buildOrgAnalyzerPrompt, buildReviseOps, coverageLine, findOpenOrgProposal, listProposals, orderForApply, proposalUrl, propose, revise, runAnalyzer, staff, summarizeInputs } from "./orgInitRun";
import { chiefOfStaffPrompt } from "@codecast/shared/contracts/chiefOfStaffPrompt";
import { orgProposalBlock } from "@codecast/shared/contracts/orgProposal";

// The review prompt is the Chief of Staff's own text
// (docs/architecture/chief-of-staff-prompt.md), filled in for the workspace.

const summary = { projects: 2, plans: 1, tasks_open: 5, members: 3, sessions_30d: 40, roles: 0, git_roots: ["/Users/me/src/app"], chief_of_staff: false, stale: { plans: 0, tasks: 0, projects: 0 } };
const deps = (over: Partial<Parameters<typeof runAnalyzer>[0]> = {}) => ({
  cliPost: async () => null,
  readWorkspace: async () => ({ kind: "team" as const, team_id: "teams_a" }),
  workspaceArgs: () => ({ team_id: "teams_a" }),
  workspaceLabel: () => "Acme",
  webUrl: () => "https://codecast.sh/",
  callingSession: () => undefined,
  realCwd: () => "/Users/me/src/app",
  ...over,
});

function capture(): { said: () => string; restore: () => void } {
  const log = console.log; const err = console.error; const out = process.stdout.write;
  let said = "";
  console.log = (...a: any[]) => { said += a.join(" ") + "\n"; };
  console.error = (...a: any[]) => { said += a.join(" ") + "\n"; };
  (process.stdout as any).write = (s: string) => { said += s; return true; };
  return { said: () => said, restore: () => { console.log = log; console.error = err; (process.stdout as any).write = out; } };
}
function trapExit(): { code: () => number | undefined; restore: () => void } {
  const exit = process.exit; let code: number | undefined;
  (process as any).exit = (c: number) => { code = c; throw new Error("exit"); };
  return { code: () => code, restore: () => { (process as any).exit = exit; } };
}

describe("buildOrgAnalyzerPrompt", () => {
  test("is the Chief of Staff's own text, with the workspace, the person and the --team flag filled in", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", teamFlag: "Acme", summary: { ...summary, person: "Ada" } });
    expect(p).toBe(chiefOfStaffPrompt({ workspace: "Acme", person: "Ada", mode: "review", team: "Acme" }));
    expect(p.startsWith("You are the Chief of Staff for Acme. You report to Ada.")).toBe(true);
    expect(p).toContain('`cast org propose --team "Acme" --spec <file>`');
  });
  test("with no chief of staff seated, the person is whoever asked for the review", () => {
    expect(buildOrgAnalyzerPrompt({ mode: "init", workspace: "Acme", summary })).toContain("You report to the person who asked for this review.");
  });
});

describe("summarizeInputs", () => {
  test("counts open tasks, lists git roots, sees a chief of staff and whom it reports to, and counts the stale records", () => {
    expect(summarizeInputs({
      projects: [{}, {}], plans: [{}], tasks: { by_status: { open: 3, done: 9, in_progress: 1, dropped: 2 } },
      members: [{}], sessions: { total: 7 }, org: { roles: [{ handle: "growth", reports_to: "@chief-of-staff" }, { handle: CHIEF_OF_STAFF_HANDLE, reports_to: "Ada" }] }, git_roots: [{ git_root: "/a" }, { git_root: "/b" }],
      activity: { areas: [], people: [], stale: { plans: [{ short_id: "pl-1" }], tasks: [{}, {}], projects: [] } },
    })).toEqual({ projects: 2, plans: 1, tasks_open: 4, members: 1, sessions_30d: 7, roles: 2, git_roots: ["/a", "/b"], chief_of_staff: true, person: "Ada", stale: { plans: 1, tasks: 2, projects: 0 } });
    // Inputs from a backend without the activity block count nothing stale.
    expect(summarizeInputs(null)).toEqual({ projects: 0, plans: 0, tasks_open: 0, members: 0, sessions_30d: 0, roles: 0, git_roots: [], chief_of_staff: false, stale: { plans: 0, tasks: 0, projects: 0 } });
  });
});

describe("findOpenOrgProposal", () => {
  test("an open init or review proposal blocks; a person's request and resolved ones do not", () => {
    expect(findOpenOrgProposal([{ short_id: "op-1", title: "Staffing for Acme", mode: "init", status: "resolved", total: 4, decided: 4 }])).toBeNull();
    expect(findOpenOrgProposal([{ short_id: "op-2", title: "Please add a role", mode: "request", status: "open", total: 1, decided: 0 }])).toBeNull();
    expect(findOpenOrgProposal([{ short_id: "op-3", title: "Company review: Acme", mode: "review", status: "open", changes: [{ status: "accepted" }, { status: "proposed" }] }])).toEqual({ short_id: "op-3", title: "Company review: Acme", decided: 1, total: 2 });
    expect(findOpenOrgProposal([{ short_id: "op-4", title: "Staffing for Acme", mode: "init", status: "open", counts: { decided: 3, total: 8 } }])).toEqual({ short_id: "op-4", title: "Staffing for Acme", decided: 3, total: 8 });
    expect(findOpenOrgProposal(undefined)).toBeNull();
  });
});

// runAnalyzer with a fake cast: an open proposal for the company stops the run
// before anything is spawned or printed; with none, the prompt prints.
describe("runAnalyzer", () => {
  const inputs = { workspace: { name: "Acme" }, projects: [], plans: [], tasks: { by_status: {} }, members: [], sessions: { total: 0 }, org: { roles: [] }, git_roots: [] };
  const fake = (proposals: any[]) => {
    const calls: Array<[string, any]> = [];
    return { calls, deps: deps({ cliPost: async (path: string, body: any) => { calls.push([path, body]); return path === "/cli/org/proposals" ? { proposals } : inputs; } }) };
  };
  test("init refuses while a proposal is open, naming it, and never hints at a withdraw", async () => {
    const { deps: d, calls } = fake([{ short_id: "op-7", title: "Staffing for Acme", mode: "init", status: "open", total: 5, decided: 2 }]);
    const cap = capture(); const ex = trapExit();
    try {
      await expect(runAnalyzer(d, "init", {})).rejects.toThrow("exit");
    } finally { cap.restore(); ex.restore(); }
    expect(ex.code()).toBe(1);
    expect(cap.said()).toContain("op-7");
    expect(cap.said()).toContain("2 of 5 decided");
    expect(cap.said()).toContain("https://codecast.sh/org?proposal=op-7");
    expect(cap.said()).not.toContain("cast org apply");
    expect(cap.said()).not.toContain("withdraw");
    expect(cap.said()).not.toContain("You are the Chief of Staff");
    expect(calls.filter(([p]) => p === "/cli/org/proposals").map(([, b]) => b)).toEqual([{ team_id: "teams_a", status: "open" }]);
  });
  // The weekly routine's ordinary Monday: last week's proposal is still open,
  // and the reference says so as a fact.
  test("a review with an open proposal states it and never tells the reviewer to withdraw", async () => {
    const { deps: d } = fake([{ short_id: "op-7", title: "Company review: Acme", mode: "review", status: "open", counts: { decided: 1, total: 6 } }]);
    const cap = capture();
    try { await runAnalyzer(d, "review", {}); } finally { cap.restore(); }
    const p = cap.said();
    expect(p).toContain("You are the Chief of Staff for Acme.");
    expect(p).toContain('Still open: op-7 "Company review: Acme", 1 of 6 changes decided.');
    expect(p).not.toContain("--withdraw");
  });
  test("with no open proposal it prints the prompt", async () => {
    const { deps: d } = fake([]);
    const cap = capture();
    try { await runAnalyzer(d, "review", {}); } finally { cap.restore(); }
    expect(cap.said()).toContain("You are the Chief of Staff for Acme.");
    expect(cap.said()).not.toContain("Still open:");
  });
});

// proposals: who posted one decides who may supersede or withdraw it, so
// the list names the author, not just its kind.
describe("listProposals", () => {
  test("names a session author by short id and title, a role by handle, a person by name", async () => {
    const rows = [
      { short_id: "op-12", title: "Company review: Acme", status: "open", mode: "review", created_at: Date.now(), counts: { decided: 0, total: 90 }, author: { kind: "session", id: "x", short_id: "jx76h54", title: "Staffing layer grounding" } },
      { short_id: "op-9", title: "Growth ask", status: "open", mode: "request", created_at: Date.now(), counts: { decided: 1, total: 1 }, author: { kind: "role", id: "y", handle: "growth", short_id: "or-9" } },
      { short_id: "op-8", title: "Hand edit", status: "open", mode: "request", created_at: Date.now(), counts: { decided: 0, total: 1 }, author: { kind: "user", id: "z", name: "Ada" } },
    ];
    const d = deps({ cliPost: async () => ({ proposals: rows }) });
    const cap = capture();
    try { await listProposals(d, {}); } finally { cap.restore(); }
    const said = cap.said();
    expect(said).toContain('session jx76h54 "Staffing layer grounding"');
    expect(said).toContain("@growth or-9");
    expect(said).toContain("a person Ada");
    expect(said).not.toContain("a session ·");
  });
});

// The org verbs a conversation runs from another workspace all take --team,
// apply included: a proposal id is global, and the flag must not be refused.
describe("registerOrgInitCommands", () => {
  test("every verb takes --team, and personal is a documented value", () => {
    const program = new Command();
    program.command("org");
    registerOrgInitCommands(program, deps());
    const org = program.commands.find((c) => c.name() === "org")!;
    for (const verb of ["inputs", "init", "update", "review", "propose", "proposals", "apply", "staff", "health"]) {
      const cmd = org.commands.find((c) => c.name() === verb)!;
      const team = cmd.options.find((o) => o.long === "--team");
      expect(team, verb).toBeDefined();
      expect(team!.description).toContain("personal");
    }
  });
});

// propose: the spec is validated before anything is posted; a good one posts
// and prints op-N with the page link.
describe("propose", () => {
  const specFile = (body: any) => { const f = `${process.env.TMPDIR ?? "/tmp"}/org-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`; require("fs").writeFileSync(f, JSON.stringify(body)); return f; };
  test("a spec with faults is refused before posting, listing every fault", async () => {
    const posted: string[] = [];
    const d = deps({ cliPost: async (path: string) => { posted.push(path); return {}; } });
    const cap = capture(); const ex = trapExit();
    try {
      await expect(propose(d, { spec: specFile({ title: "T", summary_md: "S", mode: "init", changes: [{ change: { kind: "trust", handle: "growth", trust: "god" }, rationale: "r" }] }) })).rejects.toThrow("exit");
    } finally { cap.restore(); ex.restore(); }
    expect(posted).toEqual([]);
    expect(cap.said()).toContain("changes[0] (trust): autonomy on is true or false");
  });
  test("a good spec posts with the workspace and the calling session, then prints op-N and the link", async () => {
    let body: any;
    const d = deps({ cliPost: async (path: string, b: any) => { body = [path, b]; return { short_id: "op-9", changes: [{}, {}] }; }, callingSession: () => "sess-1" });
    const cap = capture();
    try {
      await propose(d, { spec: specFile({ title: "Staffing for Acme", summary_md: "S", mode: "init", changes: [{ change: { kind: "role", name: "Growth", handle: "growth" }, rationale: "r" }, { change: { kind: "adopt", handle: "chief-of-staff", conversation: "sess-1" }, rationale: "r" }] }) });
    } finally { cap.restore(); }
    expect(body[0]).toBe("/cli/org/propose");
    expect(body[1].team_id).toBe("teams_a");
    expect(body[1].from_session).toBe("sess-1");
    expect(body[1].mode).toBe("init");
    expect(body[1].changes.length).toBe(2);
    expect(cap.said()).toContain("op-9");
    expect(cap.said()).toContain("https://codecast.sh/org?proposal=op-9");
    expect(cap.said()).not.toContain("cast org apply");
  });
});

// A proposal is decided on the org page only (S4): `cast org apply op-N`
// reads it back, in accept order, with the counts and the link, and posts
// nothing. `ds-N` keeps the template stack path.
describe("apply op-N", () => {
  const change = (seq: number, c: any, status = "proposed", applied_note?: string) => ({ _id: `chg_${seq}`, seq, change: c, rationale: `why ${c.kind}`, status, applied_note });
  const proposal = {
    proposal: { short_id: "op-4", title: "Company review: Acme", summary_md: "One line.", status: "open" },
    changes: [
      change(1, { kind: "retire", handle: "ops" }),
      change(2, { kind: "role", name: "Growth", handle: "growth" }, "applied", "created or-3"),
      change(3, { kind: "budget", handle: "growth", caps: { tokens_per_day: 800000 } }, "skipped"),
    ],
  };
  function fakeApi() {
    const posted: Array<[string, any]> = [];
    const d = deps({ cliPost: async (path: string, body: any) => { posted.push([path, body]); return path === "/cli/org/proposal" ? proposal : {}; } });
    return { d, posted };
  }
  test("prints the proposal in accept order with each change's status and the page link, and decides nothing", async () => {
    const { d, posted } = fakeApi();
    const cap = capture();
    try { await apply(d, "op-4", {}); } finally { cap.restore(); }
    expect(posted.map(([p]) => p)).toEqual(["/cli/org/proposal"]);
    const said = cap.said();
    expect(said).toContain("op-4 Company review: Acme");
    expect(said).toContain("2 of 3 decided");
    expect(said.indexOf("create role Growth @growth")).toBeLessThan(said.indexOf("budget @growth"));
    expect(said.indexOf("budget @growth")).toBeLessThan(said.indexOf("retire @ops"));
    expect(said).toContain("created or-3");
    expect(said).toContain("Decide it on the org page: https://codecast.sh/org?proposal=op-4");
    expect(said).not.toContain("accept, edit, skip");
  });
  test("inside a session it prints the same; --json carries the rows and the url", async () => {
    const { d, posted } = fakeApi();
    const cap = capture();
    try { await apply({ ...d, callingSession: () => "sess-1" }, "op-4", { json: true }); } finally { cap.restore(); }
    expect(posted.map(([p]) => p)).toEqual(["/cli/org/proposal"]);
    const out = JSON.parse(cap.said());
    expect(out.url).toBe("https://codecast.sh/org?proposal=op-4");
    expect(out.changes.map((c: any) => c.seq)).toEqual([2, 3, 1]);
  });
  test("anything but op-N or ds-N is usage", async () => {
    const { d } = fakeApi();
    const cap = capture(); const ex = trapExit();
    try { await expect(apply(d, "xy-1", {})).rejects.toThrow("exit"); } finally { cap.restore(); ex.restore(); }
    expect(cap.said()).toContain("Usage: cast org apply op-N");
    expect(proposalUrl(d, "op-2")).toBe("https://codecast.sh/org?proposal=op-2");
  });
});

// staff: a provisioned standing session starts in a project, like every other
// provisioning verb; an adopted session keeps its own path.
describe("staff", () => {
  const post = async (options: any, session?: string) => {
    let body: any;
    const d = { ...deps({ cliPost: async (_p: string, b: any) => { body = b; return { role: { name: "Chief of Staff", handle: "chief-of-staff", short_id: "or-9" }, standing: { short_id: "jx7chief" }, routine: { short_id: "tr-1" }, created: true, adopted: !!options.adopt, already_existed: false }; }, callingSession: () => session }), realCwd: () => "/Users/me/src/app" };
    const cap = capture();
    try { await staff(d, options); } finally { cap.restore(); }
    return { body, said: cap.said() };
  };
  test("posts the current directory as project_path, or --dir resolved, with every_ms", async () => {
    expect((await post({ every: "7d" })).body).toEqual({ team_id: "teams_a", every_ms: 7 * 86_400_000, project_path: "/Users/me/src/app", from_session: undefined });
    expect((await post({ every: "1d", dir: "/tmp/../tmp/x" })).body.project_path).toBe("/tmp/x");
  });
  test("--adopt sends the session and no project_path; at a shell --adopt is refused", async () => {
    const { body, said } = await post({ every: "7d", adopt: true }, "sess-1");
    expect(body).toEqual({ team_id: "teams_a", every_ms: 7 * 86_400_000, adopt_conversation_id: "sess-1", from_session: "sess-1" });
    expect(said).toContain("adopted");
    const cap = capture(); const ex = trapExit();
    try { await expect(staff({ ...deps(), realCwd: () => "/x" }, { every: "7d", adopt: true })).rejects.toThrow("exit"); } finally { cap.restore(); ex.restore(); }
    expect(cap.said()).toContain("--adopt makes THIS session");
  });
});

// Template stacks (ds-N) keep the decision stack path: ordered by proposal
// kind so a role can own a project the same stack creates.
describe("applyStack", () => {
  const dec = (id: string, proposal: any) => ({ _id: id, short_id: id, question: id, context_md: orgProposalBlock(proposal) });
  test("orderForApply: projects, then roles in stack order, then moves, then retirements, then rows without a block", () => {
    const rows = [
      dec("sd-1", { kind: "role", name: "A", handle: "a" }),
      dec("sd-2", { kind: "retire", handle: "z" }),
      dec("sd-3", { kind: "role", name: "B", handle: "b", reports_to: "@a" }),
      { _id: "sd-4", short_id: "sd-4", question: "plain", context_md: "no block" },
      dec("sd-5", { kind: "move", handle: "a", scope_add: ["Platform"] }),
      dec("sd-6", { kind: "projects", changes: [{ op: "create", title: "Platform" }] }),
    ];
    expect(orderForApply(rows).map((d) => d.short_id)).toEqual(["sd-6", "sd-1", "sd-3", "sd-5", "sd-2", "sd-4"]);
  });
  test("applyStack posts the projects decision before the role that owns the new project, and asks for a rerun when one failed", async () => {
    const posted: string[] = [];
    const d = deps({ cliPost: async (path: string, body: any) => {
      if (path === "/cli/stack/show") return { stack: { short_id: "ds-9" }, decisions: [
        dec("sd-1", { kind: "role", name: "Platform lead", handle: "platform", scope: { projects: ["Platform"] } }),
        dec("sd-2", { kind: "projects", changes: [{ op: "create", title: "Platform" }] }),
      ] };
      posted.push(body.decision);
      return body.decision === "sd-1" ? { status: "error", error: "sd-1: @platform is already or-2 (Old)", decision: "sd-1" } : { status: "applied", note: "created project", decision: "sd-2" };
    } });
    const cap = capture();
    try { await applyStack(d, "ds-9", { provision: false }); } finally { cap.restore(); }
    expect(posted).toEqual(["sd-2", "sd-1"]);
    expect(cap.said()).toContain("1 failed");
    expect(cap.said()).toContain("rerun cast org apply ds-9 after the failed ones are answered again with changes");
  });
});

// ── cast org revise (S18) ────────────────────────────────────────────────────
// The flags become the ops the server takes, in the order remove, amend,
// add; --note rides every op; the shape check runs before the post so a
// bad flag never reaches the server; the verb runs only inside a session.

describe("cast org revise", () => {
  const json = (files: Record<string, unknown>) => (value: string, flag: string) => {
    if (value in files) return files[value];
    try { return JSON.parse(value); } catch { throw new Error(`${flag} not json: ${value}`); }
  };
  /** buildReviseOps fails through process.exit; trap it and hand back what it said. */
  const failing = (fn: () => unknown): string => {
    const cap = capture(); const exit = trapExit();
    try { fn(); throw new Error("did not fail"); } catch (e: any) { if (e.message !== "exit") throw e; return cap.said(); } finally { exit.restore(); cap.restore(); }
  };
  test("flags become ops in order, --note rides each, inline JSON or a file both read", () => {
    const ops = buildReviseOps(
      { remove: ["3", "#5"], amend: "1", edits: '{"caps":{"wakes_per_day":6}}', rationale: "half", add: ["adds.json"], note: "after talking it over" },
      json({ "adds.json": [{ change: { kind: "retire", handle: "growth" }, rationale: "gone" }] }),
    );
    expect(ops).toEqual([
      { op: "remove", seq: 3, note: "after talking it over" },
      { op: "remove", seq: 5, note: "after talking it over" },
      { op: "amend", seq: 1, edits: { caps: { wakes_per_day: 6 } }, rationale: "half", note: "after talking it over" },
      { op: "add", change: { change: { kind: "retire", handle: "growth" }, rationale: "gone" }, note: "after talking it over" },
    ]);
    // A single spec change in the file, and no note.
    expect(buildReviseOps({ add: ["one.json"] }, json({ "one.json": { change: { kind: "trust", handle: "growth", trust: "direct" }, rationale: "r" } }))).toEqual([{ op: "add", change: { change: { kind: "trust", handle: "growth", trust: "direct" }, rationale: "r" } }]);
    // --ops hands the list over, filling in the note where an op has none.
    expect(buildReviseOps({ ops: "ops.json", note: "n" }, json({ "ops.json": [{ op: "remove", seq: 2 }, { op: "remove", seq: 4, note: "own" }] }))).toEqual([{ op: "remove", seq: 2, note: "n" }, { op: "remove", seq: 4, note: "own" }]);
  });

  test("refuses a bad flag before any post: nothing to do, a non-number, an amend with nothing, stray --edits, an invalid add", () => {
    const r = json({});
    expect(failing(() => buildReviseOps({}, r))).toContain("Nothing to do");
    expect(failing(() => buildReviseOps({ remove: ["x"] }, r))).toContain("--remove wants a change number like 3 (got x)");
    expect(failing(() => buildReviseOps({ amend: "2" }, r))).toContain("--amend wants --edits");
    expect(failing(() => buildReviseOps({ edits: "{}" }, r))).toContain("--edits and --rationale go with --amend <seq>");
    expect(failing(() => buildReviseOps({ add: ['{"change":{"kind":"nope"},"rationale":"r"}'] }, r))).toContain("ops[0]: add:");
    expect(failing(() => buildReviseOps({ amend: "1", edits: "[1]" }, r))).toContain("amend: edits is an object patch");
  });

  test("posts to the revise route with the calling session and prints the journal; refuses at a plain shell", async () => {
    const posts: any[] = [];
    const d = deps({
      callingSession: () => "jxanaly",
      cliPost: async (route: string, body: any) => { posts.push([route, body]); return { proposal: "op-4", status: "open", counts: { total: 2, decided: 1 }, revisions: [{ op: "removed", seq: 3, line: "retire @growth", note: "not yet" }, { op: "amended", seq: 1, line: "budget @growth wakes 6/day", was: "budget @growth wakes 12/day" }] }; },
    } as any) as any;
    const cap = capture();
    try { await revise(d, "op-4", { remove: ["3"], amend: "1", edits: '{"caps":{"wakes_per_day":6}}', note: "not yet" }); } finally { cap.restore(); }
    expect(posts).toEqual([["/cli/org/proposal/revise", { proposal: "op-4", ops: [{ op: "remove", seq: 3, note: "not yet" }, { op: "amend", seq: 1, edits: { caps: { wakes_per_day: 6 } }, note: "not yet" }], from_session: "jxanaly" }]]);
    const said = cap.said();
    expect(said).toContain("op-4");
    expect(said).toContain("1 of 2 decided");
    expect(said).toContain("retire @growth");
    expect(said).toContain("(was: budget @growth wakes 12/day)");
    expect(said).toContain("/org?proposal=op-4");
    const shell = deps({ callingSession: () => undefined } as any) as any;
    const cap2 = capture(); const exit = trapExit();
    try { await revise(shell, "op-4", { remove: ["3"] }); } catch (e: any) { expect(e.message).toBe("exit"); } finally { exit.restore(); cap2.restore(); }
    expect(cap2.said()).toContain("runs inside the session that posted the proposal");
    const cap3 = capture(); const exit3 = trapExit();
    try { await revise(d, "ds-4", { remove: ["3"] }); } catch (e: any) { expect(e.message).toBe("exit"); } finally { exit3.restore(); cap3.restore(); }
    expect(cap3.said()).toContain("Usage: cast org revise op-N");
  });
});
