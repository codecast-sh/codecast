import { describe, expect, test } from "bun:test";
import { ORG_INIT_HONESTY_RULES } from "./orgInit";
import { applyStack, buildOrgAnalyzerPrompt, findOpenOrgStack, orderForApply, orgStackTitle, runAnalyzer, summarizeInputs } from "./orgInitRun";
import { ORG_PROPOSAL_FENCE, ORG_PROPOSAL_OPTIONS, extractOrgProposal, orgProposalBlock } from "@codecast/shared/contracts/orgProposal";

// The analyzer prompt (docs/architecture/org-init.md O2): principle level,
// with the three honesty rules, the steps, and the block `cast org apply`
// reads back.

const summary = { projects: 2, plans: 1, tasks_open: 5, members: 3, sessions_30d: 40, roles: 0, git_roots: ["/Users/me/src/app"] };

describe("buildOrgAnalyzerPrompt", () => {
  test("carries the three honesty rules in both modes", () => {
    for (const mode of ["init", "update"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", apply: false, summary });
      for (const rule of Object.values(ORG_INIT_HONESTY_RULES)) expect(p).toContain(rule);
      expect(p).toContain("could not verify");
      expect(p).toContain("intake draft");
      expect(p).toContain("Never create tasks, plans, projects or sessions");
    }
  });

  test("names the inputs command, the git roots, the doc, the stack and the decisions", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "init", workspace: "Acme", teamFlag: "acme", apply: false, summary });
    expect(p).toContain('cast org inputs --team "acme" --json');
    expect(p).toContain("/Users/me/src/app");
    expect(p).toContain('cast doc create "Org proposal: Acme" -t design');
    expect(p).toContain('cast stack create "Adopt the org for Acme"');
    expect(p).toContain("--kind single --stack ds-N --no-task");
    for (const o of ORG_PROPOSAL_OPTIONS.role) expect(p).toContain(`"${o}"`);
    expect(p).toContain("2 projects, 1 plans, 5 open tasks, 3 members, 40 sessions in 30 days, 0 existing roles");
  });

  test("the example blocks parse with the same reader apply uses", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "update", workspace: "Acme", apply: true, summary });
    const blocks = p.split("```" + ORG_PROPOSAL_FENCE).slice(1).map((b) => "```" + ORG_PROPOSAL_FENCE + b.split("```")[0] + "```");
    expect(blocks.length).toBe(4);
    expect(blocks.map((b) => extractOrgProposal(b)?.kind)).toEqual(["role", "projects", "move", "retire"]);
    expect(p).toContain("run `cast org apply ds-N`");
  });

  test("without --apply the analyzer stops after posting; init mode has no move or retire block", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "init", workspace: "Acme", apply: false, summary });
    expect(p).toContain("The person runs `cast org apply ds-N` after answering");
    expect(p).not.toContain('"kind": "move"');
    expect(p).not.toContain('"kind": "retire"');
  });
});

describe("summarizeInputs", () => {
  test("counts open tasks and lists git roots", () => {
    expect(summarizeInputs({
      projects: [{}, {}], plans: [{}], tasks: { by_status: { open: 3, done: 9, in_progress: 1, dropped: 2 } },
      members: [{}], sessions: { total: 7 }, org: { roles: [{}] }, git_roots: [{ git_root: "/a" }, { git_root: "/b" }],
    })).toEqual({ projects: 2, plans: 1, tasks_open: 4, members: 1, sessions_30d: 7, roles: 1, git_roots: ["/a", "/b"] });
    expect(summarizeInputs(null)).toEqual({ projects: 0, plans: 0, tasks_open: 0, members: 0, sessions_30d: 0, roles: 0, git_roots: [] });
  });
});

// The prompt's stack title and the guard's are one string.
describe("orgStackTitle", () => {
  test("the prompt tells the analyzer to create exactly the title the guard looks for", () => {
    const p = buildOrgAnalyzerPrompt({ mode: "update", workspace: "Acme", apply: false, summary });
    expect(p).toContain(`cast stack create "${orgStackTitle("update", "Acme")}"`);
    expect(orgStackTitle("init", "Acme")).toBe("Adopt the org for Acme");
  });
});

describe("findOpenOrgStack", () => {
  const rows = [
    { short_id: "ds-1", title: "Adopt the org for Acme", team_id: "teams_a", status: "open", pending: 2, total: 4 },
    { short_id: "ds-2", title: "Org update for Acme", team_id: undefined, scope_user_id: "me", status: "open", pending: 1, total: 1 },
    { short_id: "ds-3", title: "Adopt the org for Acme", team_id: "teams_a", status: "done", pending: 0, total: 4 },
    { short_id: "ds-4", title: "Something else", team_id: "teams_a", status: "open", pending: 1, total: 1 },
  ];
  test("matches init or update for the same workspace inside the boundary only", () => {
    expect(findOpenOrgStack(rows, { team_id: "teams_a" }, "Acme")).toEqual({ short_id: "ds-1", title: "Adopt the org for Acme", pending: 2, total: 4 });
    expect(findOpenOrgStack(rows, {}, "Acme")).toEqual({ short_id: "ds-2", title: "Org update for Acme", pending: 1, total: 1 });
    expect(findOpenOrgStack(rows, { team_id: "teams_b" }, "Acme")).toBeNull();
    expect(findOpenOrgStack(rows, { team_id: "teams_a" }, "Other")).toBeNull();
    expect(findOpenOrgStack(undefined, { team_id: "teams_a" }, "Acme")).toBeNull();
  });
});

// runAnalyzer with a fake cast: an open stack for the workspace stops the run
// before anything is spawned or printed, in both modes and with --here.
describe("runAnalyzer dedupe", () => {
  const inputs = { workspace: { name: "Acme" }, projects: [], plans: [], tasks: { by_status: {} }, members: [], sessions: { total: 0 }, org: { roles: [] }, git_roots: [] };
  function fakeDeps(stacks: any[]) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        cliPost: async (path: string) => { calls.push(path); return path === "/cli/stack/ls" ? { stacks } : inputs; },
        readWorkspace: async () => ({ kind: "team" as const, team_id: "teams_a" }),
        workspaceArgs: () => ({ team_id: "teams_a" }),
        workspaceLabel: () => "Acme",
      },
    };
  }
  test("a second init refuses while the first stack is open, naming it", async () => {
    const { deps, calls } = fakeDeps([{ short_id: "ds-7", title: "Adopt the org for Acme", team_id: "teams_a", status: "open", pending: 3, total: 5 }]);
    const exit = process.exit; const err = console.error; const out = process.stdout.write;
    let code: number | undefined; let said = "";
    (process as any).exit = (c: number) => { code = c; throw new Error("exit"); };
    console.error = (m: string) => { said += m; };
    (process.stdout as any).write = () => { throw new Error("printed a prompt"); };
    try {
      await expect(runAnalyzer(deps, "init", { here: true })).rejects.toThrow("exit");
      await expect(runAnalyzer(deps, "update", { here: true })).rejects.toThrow("exit");
    } finally { (process as any).exit = exit; console.error = err; (process.stdout as any).write = out; }
    expect(code).toBe(1);
    expect(said).toContain("ds-7");
    expect(said).toContain("3 of 5 unanswered");
    expect(said).toContain("cast org apply ds-7");
    expect(calls.filter((c) => c === "/cli/stack/ls").length).toBe(2);
  });
  test("with no open stack --here prints the prompt", async () => {
    const { deps } = fakeDeps([]);
    const out = process.stdout.write; let printed = "";
    (process.stdout as any).write = (s: string) => { printed += s; return true; };
    try { await runAnalyzer(deps, "init", { here: true }); } finally { (process.stdout as any).write = out; }
    expect(printed).toContain('cast stack create "Adopt the org for Acme"');
  });
});

// applyStack orders by proposal kind so a role can own a project the same
// stack creates, and the closing line says to rerun after a failure too.
describe("applyStack order", () => {
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
    const deps = {
      cliPost: async (path: string, body: any) => {
        if (path === "/cli/stack/show") return { stack: { short_id: "ds-9" }, decisions: [
          dec("sd-1", { kind: "role", name: "Platform lead", handle: "platform", scope: { projects: ["Platform"] } }),
          dec("sd-2", { kind: "projects", changes: [{ op: "create", title: "Platform" }] }),
        ] };
        posted.push(body.decision);
        return body.decision === "sd-1" ? { status: "error", error: "sd-1: @platform is already or-2 (Old); answer with changes to pick another handle, or skip", decision: "sd-1" } : { status: "applied", note: "created project", decision: "sd-2" };
      },
      readWorkspace: async () => ({ kind: "team" as const }), workspaceArgs: () => ({}), workspaceLabel: () => "Acme",
    };
    const log = console.log; let said = "";
    console.log = (...a: any[]) => { said += a.join(" ") + "\n"; };
    try { await applyStack(deps, "ds-9", { provision: false }); } finally { console.log = log; }
    expect(posted).toEqual(["sd-2", "sd-1"]);
    expect(said).toContain("1 failed");
    expect(said).toContain("rerun cast org apply ds-9 after the failed ones are answered again with changes");
  });
});

