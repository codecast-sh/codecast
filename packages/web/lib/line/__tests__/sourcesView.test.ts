import { describe, expect, test } from "bun:test";
import { JUDGES_GROUP, sourceIn, buildSources, homeJudges, findingBreak, findingFacts, readableDetail, evidenceHost, findingsOf, flatSources, heldSince, severityOf, sourceKind, sourceName, sparkDays, type SourceFinder, type SourceSignal } from "../sourcesView";

const NOW = 1_790_000_000_000;
const H = 3_600_000;
const D = 24 * H;
let n = 0;
const sig = (source: string, ago: number, extra: Partial<SourceSignal> = {}): SourceSignal => ({ _id: `s${n++}`, source, kind: "bug", title: "t", created_at: NOW - ago, task_id: "t1", project_id: "p1", ...extra });
const finder = (source: string, id: string, projectId = "p1"): SourceFinder => ({ id, source, kind: ["bug"], fingerprint: `x:<${id}>`, projectId, projectTitle: "P" } as SourceFinder);
const run = (task_id: string, slug: string, updated_at = NOW - H) => ({ _id: `r-${task_id}-${slug}`, task_id, status: "completed", workflow_slug: slug, created_at: updated_at, updated_at });

describe("sources", () => {
  test("counts, opened against joined, and the process its problems ran", () => {
    const rows = buildSources({
      signals: [
        sig("union.eval", 2 * H, { task_id: "a", attach: "new" }),
        sig("union.eval", 3 * H, { task_id: "a", attach: "fingerprint" }),
        sig("union.eval", 3 * D, { task_id: "b", attach: "fingerprint" }),
        sig("union.eval", 10 * D, { task_id: "c", attach: "new" }),
      ],
      finders: [finder("union.eval", "evalReds")],
      runs: [run("a", "agentwatch"), run("b", "agentwatch"), run("b", "line", NOW - 2 * D)],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ name: "Eval", kind: "eval", day: 2, week: 3, total: 4, opened: 2, joined: 1, notRun: 1, state: "live" });
    // b's newest run went through AgentWatch, so both its problems count there.
    expect(r.processes).toEqual([{ key: "agentwatch", title: "AgentWatch", problems: 2 }]);
    expect(r.spark).toHaveLength(14);
    expect(r.spark[13]).toBe(2);
  });

  test("a declared finder with nothing filed is a row, never filed; one gone quiet is quiet", () => {
    const rows = buildSources({ signals: [sig("sentry", 3 * D)], finders: [finder("sentry", "errors"), finder("posthog", "drops")], runs: [], now: NOW });
    const by = new Map(rows.map((r) => [r.key, r]));
    expect(by.get("posthog")?.state).toBe("never");
    expect(by.get("sentry")?.state).toBe("quiet");
    expect(by.get("sentry")?.name).toBe("Sentry");
  });

  test("a source the project does not declare is flagged; people and lessons never are", () => {
    const rows = buildSources({ signals: [sig("app:union", H), sig("person", H), sig("lesson", H)], finders: [finder("sentry", "errors")], runs: [], now: NOW });
    const by = new Map(rows.map((r) => [r.key, r]));
    expect(by.get("app:union")).toMatchObject({ undeclared: true, state: "live", name: "Union app" });
    expect(by.get("person")).toMatchObject({ undeclared: false, name: "Person", kind: "person" });
    expect(by.get("lesson")?.undeclared).toBe(false);
  });

  test("a product's judges are its children; findings naming none stay on the source's own row", () => {
    const signals = [sig("agentwatch", H, { judge: "comms" }), sig("agentwatch", H, { judge: "comms" }), sig("agentwatch", 2 * H, { judge: "call_eval" }), sig("agentwatch", 5 * H)];
    const rows = buildSources({ signals, finders: [finder("agentwatch", "clusters")], runs: [], now: NOW });
    expect(rows[0].name).toBe("AgentWatch");
    expect(rows[0].total).toBe(4);
    expect(rows[0].children.map((c) => [c.key, c.name, c.total])).toEqual([["agentwatch/comms", "AgentWatch comms judge", 2], ["agentwatch/call_eval", "AgentWatch call eval", 1]]);
    expect(flatSources(rows).map((r) => r.key)).toEqual(["agentwatch", "agentwatch/comms", "agentwatch/call_eval"]);
    expect(findingsOf(signals, rows[0].children[0])).toHaveLength(2);
    expect(findingsOf(signals, rows[0])).toHaveLength(4);
  });

  test("busiest first: live before quiet before never", () => {
    const rows = buildSources({ signals: [sig("a.x", 3 * D), sig("b.y", H), sig("b.y", 2 * H), sig("c.z", H)], finders: [finder("a.x", "ax"), finder("d.w", "dw")], runs: [], now: NOW });
    expect(rows.map((r) => r.key)).toEqual(["b.y", "c.z", "a.x", "d.w"]);
  });
});

describe("a finding's row leads with what broke", () => {
  test("the judge's closing tag, else the first sentence of its note; never the setup its title repeats", () => {
    const md = "Reut said the Intensity and Eris matches were not the right fit. Quinn replied that he wouldn't push them but did not ask who else she would want to meet.\n\n> Given your read, I wouldn't push either introduction.\n\nno referral ask after non-fit";
    const { notes } = findingFacts(md, "Reut said the Intensity and Eris matches were not the right fit.");
    expect(findingBreak(notes)).toBe("No referral ask after non-fit");
    expect(findingBreak(["Quinn did not ask who else. Later emails do not either."])).toBe("Quinn did not ask who else.");
    expect(findingBreak([])).toBeNull();
  });
});

describe("a source's words", () => {
  test("kinds and names", () => {
    expect(sourceKind("sdk:union-errors")).toBe("errors");
    expect(sourceKind("union.escalation")).toBe("agent");
    expect(sourceKind("union.invariant")).toBe("check");
    expect(sourceKind("union.x", "comms")).toBe("judge");
    expect(sourceName("union.metric")).toBe("Metric");
    expect(sourceName("union.invariant")).toBe("Invariant");
    expect(sourceName("union.reply")).toBe("Reply");
  });
  test("severity from the field, else from the judge's words", () => {
    expect(severityOf({ severity: 4 })).toBe(4);
    expect(severityOf({ detail_md: "**Thing** (severity 8/10, execution_quality)" })).toBe(8);
    expect(severityOf({ detail_md: "nothing" })).toBeNull();
  });
  test("a finder's templated lines read as facts, the reporter's own words stay whole", () => {
    const md = [
      "1 escalation and difficulty notes under this fingerprint in the last 7 days.",
      'Ask: Fix the record, for the problem "the record is wrong".',
      "This one: a escalation from broker woken by `proactive`, 2026-10-11T10:00:00Z.",
      "",
      "The agent's reason (data, its own words):",
      "```",
      "If you add a number, the next review will see it.",
      "And the one after.",
      "```",
    ].join("\n");
    const { facts, said, notes } = findingFacts(md, "Brokers keep asking");
    expect(facts.map((f) => [f.k, f.v])).toEqual([[null, "1 in 7d"], ["ask", "Fix the record"], ["escalation", "broker · proactive"]]);
    expect(said).toBe("If you add a number, the next review will see it.\nAnd the one after.");
    expect(notes).toEqual([]);
    expect(readableDetail("This one: a escalation from a one-off agent", 0)).toBe("This one: an escalation from a one-off agent");
  });
  test("evidence host and the held window", () => {
    expect(evidenceHost("https://www.admin.example.com/a?b")).toBe("admin.example.com");
    expect(evidenceHost("not a url")).toBeNull();
    expect(heldSince(NOW - 5 * D, 1000, 1000)).toBe(NOW - 5 * D);
    expect(heldSince(NOW - 5 * D, 400, 1000)).toBeNull();
  });
  test("a day per bar, oldest first", () => {
    expect(sparkDays([NOW - H, NOW - 2 * D - H, NOW - 20 * D], NOW, 3)).toEqual([1, 0, 1]);
  });
});

test("a sync that loads a week of conversations at once counts each by the day it happened", () => {
  // Three findings loaded two hours ago, about conversations two hours, three days and nine days back.
  const rows = buildSources({ signals: [sig("judge:comms", 2 * H), sig("judge:comms", 2 * H, { observed_at: NOW - 3 * D }), sig("judge:comms", 2 * H, { observed_at: NOW - 9 * D })], finders: [], runs: [], now: NOW });
  const r = rows[0];
  expect([r.day, r.week, r.total]).toEqual([1, 2, 3]);
  expect(r.spark.filter(Boolean)).toHaveLength(3);
  // When it last filed is said once, apart: the source is live because it loaded findings today.
  expect(r.synced).toBe(NOW - 2 * H);
  expect(r.state).toBe("live");
});

test("a source declared by one project in view is not undeclared where another files it", () => {
  const rows = buildSources({ signals: [sig("union.eval", 1000, { project_id: "p2" })], finders: [finder("union.eval", "evalReds", "p1"), finder("sentry", "errors", "p2")], runs: [], now: NOW });
  expect(rows.find((r) => r.key === "union.eval")?.undeclared).toBe(false);
});

test("a first line that repeats the title past a lead-in is dropped", () => {
  expect(findingFacts("Union names no fee figure of its own.\nWhen asked, it named 1%.", "Not met: Union names no fee figure of its own").notes).toEqual(["When asked, it named 1%."]);
});

test("a source whose findings all name one judge has no child rows", () => {
  const rows = buildSources({ signals: [sig("judge:comms", 1000, { judge: "comms" }), sig("judge:comms", 2000, { judge: "comms" })], finders: [], runs: [], now: NOW });
  expect(rows[0].children).toEqual([]);
});

test("codecast's own judges, one source apiece, read as one Judges row with a judge under it each", () => {
  const rows = buildSources({ signals: [sig("judge:call", H), sig("judge:comms", 2 * H), sig("judge:comms", 3 * H), sig("agentwatch", H)], finders: [], runs: [], now: NOW });
  const group = rows.find((r) => r.key === JUDGES_GROUP)!;
  expect(rows.map((r) => r.key).sort()).toEqual(["agentwatch", JUDGES_GROUP].sort());
  expect(group.name).toBe("Codecast judges");
  expect(group.total).toBe(3);
  expect(group.children.map((c) => [c.key, c.name])).toEqual([["judge:comms", "Codecast comms judge"], ["judge:call", "Codecast call judge"]]);
  // The group's findings are every judge's; a judge's are its own.
  expect(findingsOf([sig("judge:call", H), sig("judge:comms", H), sig("agentwatch", H)], group).length).toBe(2);
  expect(sourceIn(group, "judge:match")).toBe(true);
  expect(sourceIn(group, "agentwatch")).toBe(false);
  // One judge alone stays a source of its own.
  expect(buildSources({ signals: [sig("judge:call", H)], finders: [], runs: [], now: NOW }).map((r) => r.key)).toEqual(["judge:call"]);
});

describe("the Find table and a finder's page", () => {
  const { finderRows, finderGroups, findWindow, heldFrom, wrongRateWords } = require("../sourcesView") as typeof import("../sourcesView");
  const now = 1_790_000_000_000;
  const sg = (id: string, o: Record<string, unknown>) => ({ _id: id, source: "agentwatch", kind: "prompt_miss", title: id, created_at: now - 3600_000, ...o }) as never;
  const signals = [
    sg("a", { judge: "comms", task_id: "t1" }), sg("b", { judge: "comms", task_id: "t1" }), sg("c", { judge: "comms" }), sg("d", { judge: "match", task_id: "t2" }),
    sg("e", { source: "union.escalation" }), sg("f", { source: "union.escalation", task_id: "t3" }), sg("old", { judge: "comms", created_at: now - 30 * 86400_000 }),
  ];
  const { buildSources } = require("../sourcesView") as typeof import("../sourcesView");
  const sources = buildSources({ signals, finders: [], runs: [], now });
  const marks = [{ run_id: "b", verdict: "wrong" }, { run_id: "a", verdict: "right" }];

  test("one row a finder, a product's judges each their own, with the week's findings and how many were filed", () => {
    const rows = finderRows(sources, signals, marks, findWindow(now, null).from);
    const by = new Map(rows.map((r) => [r.row.name, r]));
    expect(by.get("AgentWatch comms judge")).toMatchObject({ week: 3, filed: 1, wrong: 1, marked: 2 });
    expect(by.get("AgentWatch match judge")).toMatchObject({ week: 1, filed: 1, wrong: 0 });
    expect([...by.values()].find((r) => r.row.source === "union.escalation")).toMatchObject({ week: 2, filed: 1, wrong: null });
  });

  test("a finder that filed into two processes is listed on both tables with one count, its whole", () => {
    const process = (f: { task_id?: string | null }) => (f.task_id === "t2" ? "agentwatch" : "line");
    const from = findWindow(now, null).from;
    const here = finderRows(sources, signals, marks, from, (f) => process(f) === "line");
    const there = finderRows(sources, signals, marks, from, (f) => process(f) === "agentwatch");
    // Match filed only into agentwatch: listed there alone. Comms filed only into line.
    expect(here.map((r) => r.name)).not.toContain("AgentWatch match judge");
    expect(there.map((r) => r.name)).toEqual(["AgentWatch match judge"]);
    const both = (f: { task_id?: string | null; _id?: string }) => f._id === "d" || process(f) === "line";
    expect(finderRows(sources, signals, marks, from, both).find((r) => r.name === "AgentWatch match judge")!.week).toBe(there[0].week);
  });

  test("a judge is listed on its own product's line even when it files elsewhere, and marked where it only files", () => {
    // Codecast's comms judge files only into an AgentWatch problem; AgentWatch's judges only into codecast's line.
    const all = [sg("j1", { source: "judge:comms", task_id: "aw" }), sg("m1", { judge: "match", task_id: "cc" }), sg("m2", { judge: "comms", task_id: "cc" })];
    const src = buildSources({ signals: all, finders: [], runs: [], now });
    const from = findWindow(now, null).from;
    const at = (line: string) => finderRows(src, all, [], from, (f) => (f.task_id === "aw" ? "agentwatch" : "line") === line, line).map((r) => `${r.name}${r.filesHere ? " (files here)" : ""}`).sort();
    expect(at("line")).toEqual(["AgentWatch comms judge (files here)", "AgentWatch match judge (files here)", "Codecast comms judge"]);
    expect(at("agentwatch")).toEqual(["AgentWatch comms judge", "AgentWatch match judge", "Codecast comms judge (files here)"]);
  });

  test("a project picked keeps the line's own judges on its table, counted in that project", () => {
    // AgentWatch's judges file into the AgentWatch project; the AgentWatch Trial project holds only Codecast's judge.
    const every = [sg("j1", { source: "judge:comms", task_id: "trial", project_id: "trial" }), sg("m1", { judge: "match", task_id: "aw", project_id: "aw" }), sg("m2", { judge: "comms", task_id: "aw", project_id: "aw" })];
    const inTrial = every.filter((s: { project_id: string }) => s.project_id === "trial");
    const from = findWindow(now, null).from;
    const own = buildSources({ signals: inTrial, finders: [], runs: [], now });
    const { sources, keep } = homeJudges(own, buildSources({ signals: every, finders: [], runs: [], now }), every, from, "agentwatch");
    const rows = finderRows(sources, inTrial, [], from, () => true, "agentwatch", keep);
    expect(rows.map((r) => `${r.name} ${r.week}${r.filesHere ? " (files here)" : ""}`).sort()).toEqual(["AgentWatch comms judge 0", "AgentWatch match judge 0", "Codecast comms judge 1 (files here)"]);
    // Codecast's line adds none of AgentWatch's, and no line adds a judge twice.
    expect(homeJudges(own, buildSources({ signals: every, finders: [], runs: [], now }), every, from, "line").keep.size).toBe(0);
  });

  test("every judge reads with its product, codecast's own included, so two judges of one thing never share a name", () => {
    const rows = buildSources({ signals: [sig("judge:comms", H), sig("judge:call", H), sig("agentwatch", H, { judge: "comms" }), sig("agentwatch", H, { judge: "call_eval" })], finders: [], runs: [], now: NOW });
    const names = finderRows(rows, [sig("judge:comms", H), sig("judge:call", H), sig("agentwatch", H, { judge: "comms" }), sig("agentwatch", H, { judge: "call_eval" })] as never, [], 0).map((r) => r.name).sort();
    expect(names).toEqual(["AgentWatch call eval", "AgentWatch comms judge", "Codecast call judge", "Codecast comms judge"]);
  });

  test("a wrong rate is from marks, and a finder nobody can mark has none", () => {
    expect(wrongRateWords({ wrong: 1, week: 3 })).toBe("33% (1 of 3)");
    expect(wrongRateWords({ wrong: 0, week: 3 })).toBe("none marked wrong");
    expect(wrongRateWords({ wrong: null, week: 3 })).toBeNull();
  });

  test("a finder's week groups as filed, marked wrong and not filed, older apart; each count is the Find table's", () => {
    const comms = signals.filter((s: any) => s.judge === "comms");
    const groups = finderGroups(comms, marks, findWindow(now, null));
    expect(groups.map((g) => [g.key, g.findings.map((f: any) => f._id)])).toEqual([["filed", ["a"]], ["wrong", ["b"]], ["unfiled", ["c"]], ["older", ["old"]]]);
    const row = finderRows(sources, signals, marks, findWindow(now, null).from).find((r) => r.row.name === "AgentWatch comms judge")!;
    expect(groups.find((g) => g.key === "filed")!.findings.length).toBe(row.filed);
    expect(groups.reduce((n, g) => n + g.findings.length, 0)).toBe(comms.length);
  });

  test("a feed cut short of the week counts from when the line holds every finding, in the table and the groups alike", () => {
    const D = 86400_000;
    const rows = Array.from({ length: 5 }, (_, i) => ({ created_at: now - (i + 1) * D }));
    // Under the cap: the whole window is held, so the week is whole.
    expect(heldFrom(rows, now, 14 * D, 10)).toBeNull();
    expect(findWindow(now, heldFrom(rows, now, 14 * D, 10))).toEqual({ from: now - 7 * D, cut: false });
    // At the cap of 3: held from the third newest, two days back; a finding older than that is not in the count.
    const held = heldFrom(rows, now, 14 * D, 3);
    expect(held).toBe(now - 3 * D);
    const w = findWindow(now, held);
    expect(w).toEqual({ from: now - 3 * D, cut: true });
    // Held from before the week start: the week is whole.
    expect(findWindow(now, now - 9 * D)).toEqual({ from: now - 7 * D, cut: false });
    const esc = [sg("n1", { source: "union.escalation", created_at: now - D }), sg("n2", { source: "union.escalation", task_id: "t3", created_at: now - 2 * D }), sg("o1", { source: "union.escalation", created_at: now - 5 * D })];
    const src = buildSources({ signals: esc, finders: [], runs: [], now });
    const row = finderRows(src, esc, [], w.from)[0];
    expect(row).toMatchObject({ week: 2, filed: 1, unfiled: 1 });
    const groups = finderGroups(esc, [], w);
    expect(groups.map((g) => [g.key, g.label, g.findings.length])).toEqual([["filed", "Filed to a problem", 1], ["unfiled", "Not filed", 1], ["older", "Earlier", 1]]);
  });
});

test("finderNamed: a finder opens by its key, its shown name, or its key's last part", async () => {
  const { finderNamed } = await import("../sourcesView");
  const rows = [{ key: "union.escalation", name: "Escalation" }, { key: "judge:comms", name: "Comms" }];
  expect(finderNamed(rows, "union.escalation")?.key).toBe("union.escalation");
  expect(finderNamed(rows, "escalation")?.key).toBe("union.escalation");
  expect(finderNamed(rows, "Comms")?.key).toBe("judge:comms");
  expect(finderNamed(rows, "comms")?.key).toBe("judge:comms");
  expect(finderNamed(rows, "nothing")).toBeNull();
});
