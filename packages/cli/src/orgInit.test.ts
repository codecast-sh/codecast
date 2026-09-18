import { describe, expect, test } from "bun:test";
import { CHIEF_OF_STAFF_HANDLE, ORG_ADOPT_RULE, ORG_ASKS_RULE, ORG_ASK_RULES, ORG_LETTER_RULE, ORG_GROUNDING_RULES, ORG_INIT_HONESTY_RULES, ORG_TENURE_RULE, registerOrgInitCommands } from "./orgInit";
import { Command } from "commander";
import { COMPANY_MODEL, apply, applyStack, buildOrgAnalyzerPrompt, buildReviseOps, findOpenOrgProposal, listProposals, orderForApply, proposalUrl, propose, revise, runAnalyzer, staff, summarizeInputs } from "./orgInitRun";
import { PERSON_SPAN, ROLE_CAPACITY, ROLE_LEDGER, STABILITY, renderCapacityModel } from "@codecast/shared/contracts/orgCapacity";
import { ORG_CHANGE_KINDS, orgProposalBlock, parseOrgProposalSpec } from "@codecast/shared/contracts/orgProposal";

// The analyzer prompt (docs/architecture/org-staffing.md S8): principle level,
// built from the shared capacity model, with the three honesty rules, the
// stability rules, the adopt offer, and the spec `cast org propose` parses.

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
  test("carries the capacity model rendered from the shared module, in both modes", () => {
    for (const mode of ["init", "review"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", summary });
      expect(p).toContain(renderCapacityModel());
      for (const t of Object.values(ROLE_CAPACITY)) expect(p).toContain(t.reason);
      for (const t of Object.values(PERSON_SPAN)) expect(p).toContain(t.reason);
      expect(p).toContain(`items_per_day: ${ROLE_CAPACITY.items_per_day.value}`);
      expect(p).toContain(`open_tasks: ${ROLE_LEDGER.open_tasks.value}`);
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
      // The size line counts the company the proposal leaves behind, so a
      // proposal that creates the third project offers the seat.
      expect(ORG_ADOPT_RULE).toContain("counted after the changes in this proposal");
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
    // Every verb the prompt names takes the flag, so a run from another
    // workspace's shell reads the right company (a real run failed here once).
    expect(p).toContain('cast project show <ref> --team "acme"');
    expect(p).toContain('cast brief @handle --team "acme"');
    expect(p).toContain('cast role wakes @handle --team "acme"');
    // A review that replaces its own earlier proposal names it (S4 supersession).
    expect(p).toContain("--supersedes op-N");
    expect(p).toContain('cast org proposals --team "acme"');
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
      expect(p).toContain("states, in its rationale, the seat's resulting load against the model and its ledger as context");
      // The sizing guidance lives in the shared module, so the prompt's
      // capacity section carries nothing about thresholds of its own.
      expect(p).toContain("A wide ledger with a quiet flow is not a seat problem");
      expect(p).toContain("A role does not do its scope's tasks; hands and people do.");
      expect(p).toContain("`company.caps_total`");
      expect(p).toContain("never write it as unchanged when a seat is added");
      expect(p).toContain("Lead with the decision you are asking for");
      expect(p).toContain("The ask stays under two hundred words, in short paragraphs; a seat's sizing against the model, its evidence and its caps live in the change, not here");
      expect(p).not.toContain("allocated from the person's total");
    }
    // The split rules read from health: the streak for the ordinary case, the
    // ratio for a scope that is structurally too big, and each resulting seat
    // sized against the model.
    expect(review).toContain("`breaches` counts the consecutive earlier reviews that flagged the role");
    expect(review).toContain("a first breach on record is not a split");
    expect(review).toContain("at or above the split_on_first_breach_ratio the overloaded flag says \"split now\" and the split goes in this proposal");
    expect(review).toContain("shows each resulting seat's load against the model with its ledger as context");
    expect(review).toContain("A `wide_ledger` flag on its own is never a split");
    expect(review).toContain("busiest volume axis of the load (items a day, decisions a day, live hands)");
    expect(review).toContain(`split_on_first_breach_ratio: ${STABILITY.split_on_first_breach_ratio.value} `);
    expect(review).toContain(STABILITY.split_on_first_breach_ratio.reason);
    expect(review).toContain("3 existing roles, a chief of staff");
  });
  // S9: activity before records. The rules are named, the section stands
  // between what to read and the capacity model, the activity block is the
  // first thing read, the stale flags are answered first, and the three
  // status kinds are the first group of a proposal.
  test("grounds in activity before records: the rules, the read order, the status kinds and the record group first", () => {
    for (const mode of ["init", "review"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", summary });
      expect(p).toContain("## Ground in what is happening, not in what was filed");
      for (const rule of Object.values(ORG_GROUNDING_RULES)) expect(p).toContain(rule);
      expect(p).toContain("never staff around a stale record");
      expect(p).toContain("is a sync change, not a bottleneck");
      expect(p).toContain("A project whose path nobody touches is not a seat");
      // The activity block is read before anything else, and the section
      // sits after the reading list and before the capacity model.
      const at = (s: string) => { const i = p.indexOf(s); expect(i).toBeGreaterThanOrEqual(0); return i; };
      expect(at("its `activity` block first")).toBeLessThan(at("cast org health --json"));
      expect(at("## What to read")).toBeLessThan(at("## Ground in what is happening"));
      expect(at("## Ground in what is happening")).toBeLessThan(at("## The capacity model"));
      expect(p).toContain("`stale_plan`, `stale_task`, `stale_project`");
      // The status kinds, with a reason each, and the group they form.
      expect(p).toContain('- plan_status: { plan: ref, status: "done" | "abandoned" | "active", reason }');
      expect(p).toContain('- task_status: { task: ref, status: "done" | "dropped" | "open" | "backlog", reason }');
      // Sync before sizing, one change per plan, the cascade named, and the
      // file list coverage reported as could not verify.
      expect(p).toContain("Bring the records in line first, then size");
      // Review findings: done needs its own evidence, an average needs its
      // days, and a bypassed seat is named, not restructured on first sight.
      expect(p).toContain("A row you did not read gets no status change");
      expect(p).toContain("A finished session is not evidence that the work landed; a plan already marked done is not either");
      expect(p).toContain("as abandoned when nothing under it finished");
      expect(p).toContain("0 hands, 8 wakes and 200,000 tokens a day is the default");
      expect(p).toContain("`spend.wakes_by_day`");
      expect(p).toContain("A seat flagged `bypassed` is neither idle nor loaded");
      expect(p).toContain("Closing a plan closes its still open tasks in the same accept");
      expect(p).toContain("propose one change per plan");
      expect(p).toContain("report the rest as could not verify, never as work on the root");
      expect(p).toContain('- project_status: { project: ref, status: "paused" | "done" | "active", reason }');
      expect(p).toContain("the status changes that bring records in line come first, as their own group");
      expect(p).toContain('"Bring records in line"');
      // Loads are sized without the stale records.
      expect(p).toContain("the loads you size for a seat exclude it");
    }
    // The glance names the stale counts, so the reader expects sync changes.
    const stale = buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary: { ...summary, stale: { plans: 3, tasks: 12, projects: 0 } } });
    expect(stale).toContain("The activity block marks 3 plans, 12 tasks as stale: those are sync changes, and they come first.");
    expect(buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary })).toContain("The activity block marks no record as stale.");
    // The review reads the stale flags before any bottleneck.
    const review = buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary });
    expect(review).toContain("turn each stale record into its status change before you read anything as a bottleneck");
  });
  // S17: the ask is a letter to a reader who has never seen the feature. The
  // rules are named, the decision leads, every invented word is explained or
  // dropped, numbers carry their meaning, the cost is in plain words, the
  // bound holds, and the old packing instruction (one line of records, one
  // sentence per seat, a budget as bare numbers) is gone.
  test("writes the ask for a reader who has never seen the feature: the rules, the decision first, the bound, no packing", () => {
    for (const mode of ["init", "review"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", summary });
      expect(p).toContain("The summary is the ask.");
      for (const rule of Object.values(ORG_ASK_RULES)) expect(p).toContain(rule);
      expect(p).toContain("has never heard of a role, a scope, a charter, a hand, a wake or a budget in tokens");
      expect(p).toContain("explained in plain words the first time it appears, or not used at all");
      expect(p).toContain("A signal from the health report is told as what is happening, never by its name");
      expect(p).toContain("A short id never stands in for a name");
      expect(p).toContain("Counts joined by commas are a defect");
      expect(p).toContain("A budget stated as bare numbers is not a cost");
      expect(p).toContain("A sentence they would have to reread or decode is a defect in the summary");
      // Run 1 on the Codecast workspace showed these gaps: a cost counted in
      // wake ups nobody defined, a new agent named by its title after being
      // introduced as "one new agent", project names as bare lowercase words,
      // and "seats" leaking through the lines after the ask.
      expect(p).toContain("a unit of spend is explained where the cost is stated, as what it lets an agent do, the first time it appears");
      // S19: the page says the cost as one line ("about a quarter less");
      // units on the first screen are the arithmetic, which goes below.
      expect(p).toContain("on the first screen it is a comparison with today that a person can picture");
      // The page's cost line reads the limit that costs money (costLine in
      // web/components/org/staffingAsks.ts); a run that compared every unit
      // wrote "a third to three quarters, depending on the unit".
      expect(p).toContain("Read that share from the limit that costs money, how much the roles may read and write in a day");
      expect(p).toContain("introduced once with what it is and what it will do, and called by those same words after that");
      expect(p).toContain("A project's or a plan's name appears as it is filed, capitalized or quoted");
      expect(p).toContain("read the whole summary once more as that person, the lines after the ask included");
      // Run 2 showed "a standing agent" spending an invented word in the
      // sentence that introduces the thing, and the inputs' own names
      // ("the activity block credits", "the seat should end with it")
      // leaking into the lines below the ask.
      expect(p).toContain("a role that stays is said as staying, not as standing");
      expect(p).toContain("that holds for every line of the summary, the asks, the evidence, what could not be verified and the findings, not the ask alone");
      expect(p).toContain("The names of the inputs you read (an activity block, a health flag, a ledger, a frame) never reach the reader");
      // Run 3 wrote "may wake 120 times a day" with no word on what a wake
      // is, while it explained a token; the rule now asks for both.
      expect(p).toContain("A count of wakes never stands alone: wherever the number appears, say in your own words what one wake is");
      // Run 4 handed in a project_meta for one project twice (its charter list
      // and its owner list); the prompt says one row per subject and what
      // the post does with a repeat.
      expect(p).toContain("A proposal names each subject once: one status per plan or task, one project_meta carrying every field you set for a project");
      expect(p).toContain("two rows that agree about one subject are folded into one at the post and named, and two that disagree are refused");
      // The decision leads, and the ask rules sit inside the writing section.
      const at = (s: string) => { const i = p.indexOf(s); expect(i).toBeGreaterThanOrEqual(0); return i; };
      expect(at("## How to write")).toBeLessThan(at("The summary is the ask."));
      expect(at("The summary is the ask.")).toBeLessThan(at("## What not to invent"));
      expect(at(ORG_ASK_RULES.reader)).toBeLessThan(at(ORG_ASK_RULES.decision_first));
      expect(at(ORG_ASK_RULES.decision_first)).toBeLessThan(at(ORG_ASK_RULES.invented_words));
      // S19: the analyzer writes the asks, a partition of the changes, in
      // the words its summary already uses; the spec example carries one and
      // parses with it.
      expect(p).toContain(ORG_ASKS_RULE);
      expect(p).toContain("every change is in exactly one ask; the post refuses a spec that leaves a change out or names one twice");
      expect(p).toContain("when the summary says one, two, three, those are the asks");
      // The first run of the rule wrote titles of 30, 25 and 17 words, each
      // carrying its own reason; a title is the head of a card.
      expect(p).toContain("A title is the head of a card: a short line, about ten words, that names the act the person is agreeing to");
      expect(p).toContain("The reason does not go in the title, it goes in why");
      expect(at("## How to write")).toBeLessThan(at(ORG_ASKS_RULE));
      expect(at(ORG_ASKS_RULE)).toBeLessThan(at("The summary is the ask."));
      // S19, the letter shape: the page shows the words the propose step
      // wrote, so the first screen is decided in the prompt. A live letter
      // opened with one 1,088 character paragraph; the shape is an opening,
      // one short paragraph per ask, then the rest behind a heading.
      expect(p).toContain(ORG_LETTER_RULE);
      expect(p).toContain("one short paragraph that says what you are, what you looked at and that they decide; then one short paragraph per ask, in the asks' order, each ending in what accepting changes for the reader; then nothing");
      expect(p).toContain("a person reads them in ten seconds and can say what is asked of them");
      expect(p).toContain("An ask's why is one sentence and its effect is one sentence");
      // The live cards said "standing agents", "business line", "daily
      // allowance" and "seat", and one effect was an inventory of 100 rows:
      // the first screen carries the page's words, and the effect names what
      // the person will notice.
      expect(p).toContain("a role is the thing you add, retire or move (say once that a role is an agent that keeps watching one area of work, and call it a role from then on, in the letter and in every ask)");
      expect(p).toContain("a daily limit is what it may spend, and a role that stays is said as staying, not as standing");
      expect(p).toContain("The first screen carries the page's word and nothing else");
      expect(p).toContain("the effect names what the person will notice once they accept, never what the machine will do row by row");
      expect(at(ORG_ASKS_RULE)).toBeLessThan(at(ORG_LETTER_RULE));
      expect(at(ORG_LETTER_RULE)).toBeLessThan(at("The summary is the ask."));
      const example = parseOrgProposalSpec(JSON.parse(p.split("```json\n")[1].split("\n```")[0]));
      expect(example.errors).toEqual([]);
      expect(example.spec!.asks).toEqual([{ title: "What the person is agreeing to, readable on its own", why: "One sentence of why.", effect: "One line of what changes for them when they accept.", seqs: [1] }]);
      // What comes after the ask is written for the same reader.
      expect(p).toContain("each line is written for the same reader, so the ask stays on top and nothing below it asks them to learn a word");
      // The packing instruction that produced an inventory is gone.
      expect(p).not.toContain("one sentence per seat");
      expect(p).not.toContain("the records to bring in line in one line");
      expect(p).not.toContain("the company budget before and after");
    }
  });
  // S10: every proposed role is standing or a program, says which, and names
  // its end; tenure rides on the role change and the spec example carries it.
  test("decides standing versus program for every role, with the end condition, and puts tenure in the role change", () => {
    for (const mode of ["init", "review"] as const) {
      const p = buildOrgAnalyzerPrompt({ mode, workspace: "Acme", summary });
      expect(p).toContain("## Standing and program roles");
      expect(p).toContain(ORG_TENURE_RULE);
      expect(p).toContain("When in doubt, a program");
      expect(p).toContain('tenure: { kind: "standing" } | { kind: "program", ends: { plan: ref } | { project: ref } | { date: unix ms }, then: "retire" | "review" }');
      expect(p).toContain("Every role change carries its tenure, and its rationale says why standing or why a program and what ends it");
      expect(p).toContain("`program_ended`");
      expect(p).toContain('horizon?: "ongoing" | "bounded"');
      const json = p.split("```json\n")[1].split("\n```")[0];
      const parsed = parseOrgProposalSpec(JSON.parse(json));
      expect(parsed.errors).toEqual([]);
      expect((parsed.spec!.changes[0].change as any).tenure).toEqual({ kind: "standing" });
    }
    expect(buildOrgAnalyzerPrompt({ mode: "init", workspace: "Acme", summary })).toContain("say whether the seat is standing or a program");
    // S12: the chief of staff is the workspace's anchor; the analyzer's own
    // session is the adopt target only where no anchor exists.
    const offer = buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary, session: "abc-123" });
    expect(offer).toContain("`cast anchor ls --json`");
    expect(offer).toContain("Only a workspace with no anchor adopts this session");
    expect(offer).toContain("This session is `abc-123`; that is the adopt change's conversation only when the workspace has no anchor");
    expect(buildOrgAnalyzerPrompt({ mode: "review", workspace: "Acme", summary })).toContain("program roles whose end has come");
  });
});

describe("summarizeInputs", () => {
  test("counts open tasks, lists git roots, sees a chief of staff and counts the stale records", () => {
    expect(summarizeInputs({
      projects: [{}, {}], plans: [{}], tasks: { by_status: { open: 3, done: 9, in_progress: 1, dropped: 2 } },
      members: [{}], sessions: { total: 7 }, org: { roles: [{ handle: "growth" }, { handle: CHIEF_OF_STAFF_HANDLE }] }, git_roots: [{ git_root: "/a" }, { git_root: "/b" }],
      activity: { areas: [], people: [], stale: { plans: [{ short_id: "pl-1" }], tasks: [{}, {}], projects: [] } },
    })).toEqual({ projects: 2, plans: 1, tasks_open: 4, members: 1, sessions_30d: 7, roles: 2, git_roots: ["/a", "/b"], chief_of_staff: true, stale: { plans: 1, tasks: 2, projects: 0 } });
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
