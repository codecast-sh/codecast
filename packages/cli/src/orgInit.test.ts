import { describe, expect, test } from "bun:test";
import { ORG_INIT_HONESTY_RULES, buildOrgAnalyzerPrompt, summarizeInputs } from "./orgInit";
import { ORG_PROPOSAL_FENCE, ORG_PROPOSAL_OPTIONS, extractOrgProposal } from "@codecast/shared/contracts";

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
