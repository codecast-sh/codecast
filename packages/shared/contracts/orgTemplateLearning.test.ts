import { describe, expect, test } from "bun:test";
import { LEARNING, canaryVerdict, draftDue, learningRequest, lessonLeaks, nextPatch, parseLessons, playbookRuleSignals, structuralSignals, workspaceTerms } from "./orgTemplateLearning";
import { parsePlaybook } from "./rolePlaybook";
import type { OrgTemplate } from "./orgTemplateManifest";

// The learning loop's rules (org-hire.md H12): what counts as a signal, what a
// lesson may not carry out of a workspace, and when lessons become a release.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const manifest: OrgTemplate = {
  schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "Positioning, measurement and steady marketing for one project",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 } },
  inputs: [{ key: "product.domain", label: "Domain", kind: "string" }, { key: "product.name", label: "Product", kind: "string" }, { key: "branch", label: "Branch", kind: "string" }, { key: "budget", label: "Budget", kind: "money" }],
  setup: [{ id: "search-console", title: "Verify the domain", who: "human" }, { id: "measurement", title: "See one event", who: "role" }],
  evidence: [{ id: "technical", title: "Crawler HTML verified", max_age: "7d" }],
  routines: [{ id: "seo", title: "SEO weekly", every: "7d", prompt: "org/seo.md" }, { id: "ads", title: "Ads daily", every: "1d", prompt: "org/ads.md" }],
};

describe("the leak check", () => {
  const facts = { people: [{ name: "Dana Whitfield", email: "dana@acme.com", github_username: "dwhit" }], team: "Acme Robotics", projects: ["Growth", "Warehouse Portal"], instance: "acme-growth", handle: "acme-growth-cmo", config: { "product.domain": "acme.com", "product.name": "Pallet", branch: "main", budget: "300" }, host: { machine: "danas-mbp.local", dir: "/Users/dana/src/pallet-web" } };
  const terms = workspaceTerms(facts, manifest);

  test("a lesson in general terms, in the template's own vocabulary, passes", () => {
    expect(lessonLeaks("The search-console step asks a person to verify a domain without saying which account owns it. The guide should open with how to find the owning account, and the seo routine should say it waits on this step.", terms)).toEqual([]);
    expect(lessonLeaks("The role runs `cast org template evidence` before the check has anything to observe; the charter should say to record evidence only after a run.", terms)).toEqual([]);
  });
  test("an email, a link or domain, an id, a quotation and code are each refused by kind", () => {
    expect(lessonLeaks("Send the report to ops@example.org before the weekly run.", [])).toEqual(["email", "url"]);
    expect(lessonLeaks("The guide should link https://search.google.com/search-console directly.", [])).toEqual(["url"]);
    expect(lessonLeaks("The landing page at shopfront.io was never crawled.", [])).toEqual(["url"]);
    for (const id of ["ct-4102", "tr-42", "doc:k17abc", "jx7c6zk", "LIN-482", "#1284", "a3f9c2d47b10e6f2", "0f8fad5b-d9cb-469f-a165-70867728950e"]) expect(lessonLeaks(`The run for ${id} stalled on a missing credential.`, [])).toEqual(["id"]);
    expect(lessonLeaks('The person said "stop posting drafts before I have read them" twice.', [])).toEqual(["quote"]);
    expect(lessonLeaks("> never post without review\nThe charter should require review.", [])).toEqual(["quote"]);
    expect(lessonLeaks("Use this:\n```\ncurl -X POST\n```", [])).toEqual(["code"]);
  });
  test("a short quoted term is not a quotation", () => {
    expect(lessonLeaks('The routine reports "ready" before its evidence exists; it should wait for the first pass record.', [])).toEqual([]);
  });
  test("a name from the workspace is refused: people, team, projects, the instance, answers and the host", () => {
    for (const text of ["Dana asked for a shorter report.", "The team at Acme Robotics wanted weekly numbers.", "The Warehouse Portal launch changed the plan.", "The acme-growth instance never bound its secret.", "Pallet's pricing page was the wrong target.", "The checkout in pallet-web had no workspace file.", "dwhit merged the change by hand."]) expect(lessonLeaks(`${text} The charter should ask about report length at the first wake.`, terms)).toEqual(["name"]);
  });
  test("a plain word matches only as written, so a project called Growth does not refuse the word", () => {
    const own = workspaceTerms({ projects: ["Signal"], people: [{ name: "Will Marks" }] }, manifest);
    expect(lessonLeaks("The routine should signal when it will skip a run, and say why.", own)).toEqual([]);
    expect(lessonLeaks("The Signal launch moved the date.", own)).toEqual(["name"]);
  });
  test("the template's and the platform's words are not the workspace's; plain answers are not names", () => {
    const own = workspaceTerms({ team: "Codecast", projects: ["Growth", "CMO"], config: { branch: "main", budget: "300", "product.name": "weekly" } }, manifest);
    expect(own).toEqual([]);
    expect(terms).toEqual(expect.arrayContaining(["Dana Whitfield", "Dana", "Whitfield", "dana@acme.com", "dwhit", "Acme Robotics", "Acme", "Warehouse Portal", "acme-growth", "acme.com", "Pallet", "danas-mbp.local", "pallet-web"]));
    expect(terms).not.toContain("main");
    expect(terms).not.toContain("Growth");
  });
});

describe("structural signals", () => {
  const routines = [{ id: "seo", trigger: { status: "paused", run_count: 0 } }, { id: "ads", trigger: { status: "scheduled", run_count: 4, last_run_at: NOW - DAY, last_run_failed: true } }];
  const readiness = { seo: { ready: true, mode: "propose" as const, missing: [] }, ads: { ready: true, mode: "propose" as const, missing: [] } };
  const state = { setup: { measurement: { status: "skipped" as const } }, evidence: { technical: { status: "pass" as const, observed_at: NOW - 10 * DAY, source: "ct-1" } } };

  test("an old open step, a skipped step, a failed run, an idle ready routine and stale evidence, in the manifest's words", () => {
    const signals = structuralSignals(manifest, { state, readiness, routines, hired_at: NOW - 9 * DAY }, NOW);
    expect(signals.map((s) => s.key)).toEqual(["setup:search-console:open", "setup:measurement:skipped", "routine:seo:idle", `routine:ads:failed:${NOW - DAY}`, `evidence:technical:stale:${NOW - 10 * DAY}`]);
    expect(signals[0]).toMatchObject({ kind: "setup", about: "search-console" });
    expect(signals[0]!.line).toContain("Verify the domain");
  });
  test("a young hire has no stall, a blocked routine waits two weeks, and a signal already taught is not repeated", () => {
    expect(structuralSignals(manifest, { state: {}, readiness, routines: [routines[0]!], hired_at: NOW - DAY }, NOW)).toEqual([]);
    const blocked = { ...readiness, seo: { ready: false, mode: "propose" as const, missing: ["evidence technical has no pass"] } };
    expect(structuralSignals(manifest, { state: {}, readiness: blocked, routines: [routines[0]!], hired_at: NOW - 8 * DAY }, NOW).map((s) => s.key)).toEqual(["setup:search-console:open", "setup:measurement:open"]);
    expect(structuralSignals(manifest, { state: {}, readiness: blocked, routines: [routines[0]!], hired_at: NOW - 15 * DAY, seen: ["setup:search-console:open", "setup:measurement:open"] }, NOW).map((s) => s.key)).toEqual(["routine:seo:blocked"]);
  });
});

describe("the request and its reply", () => {
  test("the request names the template's ids and carries the signals and what people typed", () => {
    const { system, prompt } = learningRequest(manifest, { redirects: [{ before: "I posted the draft.", said: "No, never post before I read it." }], signals: [{ key: "k", kind: "routine", about: "ads", line: "Routine ads (Ads daily) failed its last run.", detail: "Billing was not set up." }] });
    expect(system).toContain("Reply [] when nothing generalizes");
    for (const part of ["search-console: Verify the domain (a person's)", "seo: SEO weekly (every 7d)", "technical: Crawler HTML verified (good for 7d)", "Routine ads (Ads daily) failed its last run. The role's summary of it: Billing was not set up.", "The role had said: I posted the draft.", "A person then typed: No, never post before I read it."]) expect(prompt).toContain(part);
    expect(learningRequest(manifest, { redirects: [{ said: "x".repeat(2000) }], signals: [] }).prompt.length).toBeLessThan(1700);
  });
  test("malformed entries are dropped, an unknown target is the charter, and a pass files at most eight", () => {
    const lesson = "The charter should ask how often a person wants reports.";
    expect(parseLessons([{ kind: "redirect", about: "nowhere", lesson }, { kind: "routine", about: "ads", lesson }, { kind: "gossip", about: "ads", lesson }, { kind: "setup", about: "ads", lesson: "short" }, "text", null], manifest)).toEqual([{ kind: "redirect", about: "charter", lesson }, { kind: "routine", about: "ads", lesson }]);
    expect(parseLessons({ lesson }, manifest)).toEqual([]);
    expect(parseLessons(Array.from({ length: 20 }, () => ({ kind: "setup", about: "measurement", lesson })), manifest)).toHaveLength(LEARNING.lessons_per_pass);
  });
});

describe("from lessons to a release", () => {
  const open = (age: number) => ({ status: "open", created_at: NOW - age });
  test("a draft is due at three open lessons, or when one has waited two weeks", () => {
    expect(draftDue([open(DAY), open(DAY), { status: "accepted", created_at: 0 }], NOW)).toMatchObject({ due: false, open: 2 });
    expect(draftDue([open(DAY), open(DAY), open(DAY)], NOW)).toMatchObject({ due: true, open: 3 });
    expect(draftDue([open(15 * DAY)], NOW)).toMatchObject({ due: true, open: 1 });
    expect(draftDue([], NOW)).toMatchObject({ due: false, why: "no open lessons" });
  });
  test("a canary is clean only when an instance ran it without failure, nothing was learned on it, and it soaked", () => {
    const ran = { on_release: true, ran: true, failed: false };
    const published_at = NOW - 4 * DAY;
    expect(canaryVerdict({ published_at, instances: [ran], lessons_since: 0 }, NOW).clean).toBe(true);
    expect(canaryVerdict({ published_at, instances: [], lessons_since: 0 }, NOW)).toMatchObject({ clean: false, why: "no instance follows canary: a person promotes" });
    expect(canaryVerdict({ published_at, instances: [{ ...ran, on_release: false }], lessons_since: 0 }, NOW).clean).toBe(false);
    expect(canaryVerdict({ published_at, instances: [ran, { ...ran, failed: true }], lessons_since: 0 }, NOW).clean).toBe(false);
    expect(canaryVerdict({ published_at, instances: [ran, { ...ran, ran: false }], lessons_since: 0 }, NOW).clean).toBe(false);
    expect(canaryVerdict({ published_at, instances: [ran], lessons_since: 1 }, NOW).clean).toBe(false);
    expect(canaryVerdict({ published_at: NOW - DAY, instances: [ran], lessons_since: 0 }, NOW)).toMatchObject({ clean: false, why: "canary for 24 hours of 72" });
  });
  test("a draft takes the next patch after the newest release", () => {
    expect(nextPatch(["2.0.0", "2.1.3", "2.1.0"])).toBe("2.1.4");
    expect(nextPatch(["1.9.9", "1.10.0"])).toBe("1.10.1");
  });
});

// A role's playbook (org-staffing.md S38) feeds the loop: the rules it taught
// itself are signals, each read once.
describe("rules the role taught itself", () => {
  const rules = parsePlaybook([
    "## Rules learned",
    "- Check the live page before calling a page shipped. Learned from: a post sat merged and unpublished for four days. (2026-09-20)",
    "- Read the replies, not the reply rate. Learned from: two diagnoses made from totals were wrong. (2026-09-28)",
    "- Short. (2026-09-29)",
  ].join("\n")).rules;

  test("newest first, keyed by what they say, and one already taught from is left out", () => {
    const signals = playbookRuleSignals(rules);
    expect(signals.map((r) => r.rule)).toEqual(["Read the replies, not the reply rate.", "Check the live page before calling a page shipped."]);
    expect(signals[0].mistake).toBe("two diagnoses made from totals were wrong");
    expect(playbookRuleSignals(rules, [signals[0].key]).map((r) => r.rule)).toEqual(["Check the live page before calling a page shipped."]);
    // The key reads the words, so a redated or respaced line is the same rule.
    const again = parsePlaybook("## Rules learned\n-  read the replies,  not the reply rate.  Learned from: two diagnoses made from totals were wrong (2026-10-02)").rules;
    expect(playbookRuleSignals(again)[0].key).toBe(signals[0].key);
    expect(playbookRuleSignals(Array.from({ length: 40 }, (_, i) => ({ text: `Rule number ${i} about the template`, mistake: null, written_at: i }))).length).toBe(LEARNING.rules);
  });

  test("the request lists them under their own heading, and a lesson may be drawn from one", () => {
    const { system, prompt } = learningRequest(manifest, { redirects: [], signals: [], rules: playbookRuleSignals(rules) });
    expect(prompt).toContain("# Rules the role taught itself\n\n- Read the replies, not the reply rate. It learned this from: two diagnoses made from totals were wrong");
    expect(learningRequest(manifest, { redirects: [], signals: [] }).prompt).toContain("# Rules the role taught itself\n\n- none");
    expect(system).toContain('"rule"');
    expect(parseLessons([{ kind: "rule", about: "charter", lesson: "The charter should tell the role to read replies before it judges a campaign by its reply rate." }], manifest)).toHaveLength(1);
  });
});
