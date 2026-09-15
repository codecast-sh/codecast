import { describe, expect, test } from "bun:test";
import { CHIEF_OF_STAFF_HANDLE, ORG_ADOPT_RULE, ORG_INIT_HONESTY_RULES } from "./orgInit";
import { COMPANY_MODEL, apply, applyStack, buildOrgAnalyzerPrompt, findOpenOrgProposal, orderForApply, proposalUrl, propose, runAnalyzer, staff, summarizeInputs } from "./orgInitRun";
import { PERSON_SPAN, ROLE_CAPACITY, STABILITY, renderCapacityModel } from "@codecast/shared/contracts/orgCapacity";
import { ORG_CHANGE_KINDS, orgProposalBlock, parseOrgProposalSpec } from "@codecast/shared/contracts/orgProposal";

// The analyzer prompt (docs/architecture/org-staffing.md S8): principle level,
// built from the shared capacity model, with the three honesty rules, the
// stability rules, the adopt offer, and the spec `cast org propose` parses.

const summary = { projects: 2, plans: 1, tasks_open: 5, members: 3, sessions_30d: 40, roles: 0, git_roots: ["/Users/me/src/app"], chief_of_staff: false };
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
  test("carries the capacity model rendered from the shared module, in both modes", () => {
    for (const mode of ["init", "review"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", summary });
      expect(p).toContain(renderCapacityModel());
      for (const t of Object.values(ROLE_CAPACITY)) expect(p).toContain(t.reason);
      for (const t of Object.values(PERSON_SPAN)) expect(p).toContain(t.reason);
      expect(p).toContain(`open_tasks: ${ROLE_CAPACITY.open_tasks.value}`);
    }
  });
  test("carries the three honesty rules, the stability rules and the adopt rule", () => {
    for (const mode of ["init", "review"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", summary });
      for (const rule of Object.values(ORG_INIT_HONESTY_RULES)) expect(p).toContain(rule);
      expect(p).toContain("could not verify");
      expect(p).toContain("intake draft");
      for (const t of Object.values(STABILITY)) expect(p).toContain(t.reason);
      expect(p).toContain(ORG_ADOPT_RULE);
      expect(p).toContain(COMPANY_MODEL);
      expect(p).toContain("staffing is budgeting");
    }
  });
  test("names what to read, the git roots, the propose command and the end state; never an apply by the analyzer", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "init", workspace: "Acme", teamFlag: "acme", summary });
    expect(p).toContain('cast org inputs --team "acme" --json');
    expect(p).toContain('cast org health --team "acme" --json');
    expect(p).toContain("/Users/me/src/app");
    expect(p).toContain('cast org propose --team "acme" --spec proposal.json');
    expect(p).toContain("cast state --status done");
    expect(p).toContain("that page is the only door, and nothing you run applies a change");
    expect(p).not.toContain("cast org apply");
    expect(p).not.toContain("cast stack create");
    expect(p).not.toContain("cast decide ");
    expect(p).toContain("2 projects, 1 plans, 5 open tasks, 3 members, 40 sessions in 30 days, 0 existing roles, no chief of staff");
  });
  test("the spec example parses with the reader cast org propose uses, and every change kind is described", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary });
    const json = p.split("```json\n")[1].split("\n```")[0];
    const parsed = parseOrgProposalSpec(JSON.parse(json));
    expect(parsed.errors).toEqual([]);
    expect(parsed.spec!.changes[0].change.kind).toBe("role");
    for (const kind of ORG_CHANGE_KINDS) expect(p).toContain(`- ${kind}: {`);
  });
  test("init designs from business lines; review reads flags and respects stability; the offer names the session or says it cannot", () => {
    const init = buildOrgAnalyzerPrompt({ mode: "init", workspace: "Acme", summary, session: "abc-123" });
    expect(init).toContain("## How to design from scratch");
    expect(init).toContain("Start from the business lines");
    expect(init).not.toContain("## How to review");
    expect(init).toContain("This session is `abc-123`");
    const review = buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary: { ...summary, roles: 3, chief_of_staff: true } });
    expect(review).toContain("## How to review");
    expect(review).toContain("smallest change that removes it");
    expect(review).not.toContain("## How to design from scratch");
    expect(review).toContain("skip the offer and say so");
    // An unfiled plan is a file change, filed ahead of the role that needs it.
    expect(review).toContain("- file: { plan: ref, project: ref }");
    expect(review).toContain("A plan with open work and no project is a file change, not a finding");
    expect(review).toContain("propose their file changes first in the same proposal");
    expect(review).toContain("Work moves between roles by moving the plan");
    // The review findings: every seat is sized in its rationale, budgets are
    // stated against the company total health reports, the summary leads
    // with the decision, and a split reads the breach count.
    for (const p of [init, review]) {
      expect(p).toContain("states, in its rationale, the seat's resulting open tasks, in-flight tasks and active plans against the model");
      expect(p).toContain("`company.caps_total`");
      expect(p).toContain("never write it as unchanged when a seat is added");
      expect(p).toContain("Lead with the decision you are asking for");
      expect(p).toContain("Keep it under two hundred words");
      expect(p).not.toContain("allocated from the person's total");
    }
    expect(review).toContain("`breaches` counts the consecutive earlier reviews that flagged the role, so a first breach on record is never a split");
    expect(review).toContain("3 existing roles, a chief of staff");
  });
});

describe("summarizeInputs", () => {
  test("counts open tasks, lists git roots and sees a chief of staff", () => {
    expect(summarizeInputs({
      projects: [{}, {}], plans: [{}], tasks: { by_status: { open: 3, done: 9, in_progress: 1, dropped: 2 } },
      members: [{}], sessions: { total: 7 }, org: { roles: [{ handle: "growth" }, { handle: CHIEF_OF_STAFF_HANDLE }] }, git_roots: [{ git_root: "/a" }, { git_root: "/b" }],
    })).toEqual({ projects: 2, plans: 1, tasks_open: 4, members: 1, sessions_30d: 7, roles: 2, git_roots: ["/a", "/b"], chief_of_staff: true });
    expect(summarizeInputs(null)).toEqual({ projects: 0, plans: 0, tasks_open: 0, members: 0, sessions_30d: 0, roles: 0, git_roots: [], chief_of_staff: false });
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
    expect(cap.said()).not.toContain("# Propose");
    expect(calls.filter(([p]) => p === "/cli/org/proposals").map(([, b]) => b)).toEqual([{ team_id: "teams_a", status: "open" }]);
  });
  // The weekly routine's ordinary Monday: last week's proposal is still open.
  // The review runs, reads, and adds nothing; it never withdraws.
  test("a review with an open proposal prints a standing review that reads and does not repost or withdraw", async () => {
    const { deps: d } = fake([{ short_id: "op-7", title: "Company review: Acme", mode: "review", status: "open", counts: { decided: 1, total: 6 } }]);
    const cap = capture();
    try { await runAnalyzer(d, "review", {}); } finally { cap.restore(); }
    const p = cap.said();
    expect(p).toContain("# Review the company: Acme");
    expect(p).toContain("## A proposal is still open");
    expect(p).toContain('op-7 "Company review: Acme" waits on a person: 1 of 6 changes decided, at https://codecast.sh/org?proposal=op-7');
    expect(p).toContain("Do not post a second proposal while it is open, and do not withdraw it");
    expect(p).not.toContain("cast org proposals --withdraw");
  });
  test("with no open proposal it prints the prompt for the mode, naming the calling session", async () => {
    const { deps: d } = fake([]);
    const cap = capture();
    try {
      await runAnalyzer({ ...d, callingSession: () => "sess-1" }, "review", {});
    } finally { cap.restore(); }
    expect(cap.said()).toContain("# Review the company: Acme");
    expect(cap.said()).toContain("This session is `sess-1`");
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
    expect(cap.said()).toContain("changes[0] (trust): trust is one of understand, decide, direct");
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
