import { describe, expect, test } from "bun:test";
import { buildSources, detailLines, evidenceHost, findingsOf, flatSources, heldSince, severityOf, sourceKind, sourceName, sparkDays, type SourceFinder, type SourceSignal } from "../sourcesView";

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
    expect(r).toMatchObject({ name: "Eval reds", kind: "eval", day: 2, week: 3, total: 4, opened: 2, joined: 1, notRun: 1, state: "live" });
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
    expect(by.get("person")).toMatchObject({ undeclared: false, name: "People", kind: "person" });
    expect(by.get("lesson")?.undeclared).toBe(false);
  });

  test("a product's judges are its children, findings naming none together last", () => {
    const signals = [sig("agentwatch", H, { judge: "comms" }), sig("agentwatch", H, { judge: "comms" }), sig("agentwatch", 2 * H, { judge: "call_eval" }), sig("agentwatch", 5 * H)];
    const rows = buildSources({ signals, finders: [finder("agentwatch", "clusters")], runs: [], now: NOW });
    expect(rows[0].name).toBe("AgentWatch");
    expect(rows[0].children.map((c) => [c.key, c.name, c.total])).toEqual([["agentwatch/comms", "Comms", 2], ["agentwatch/call_eval", "Call eval", 1], ["agentwatch/", "No judge named", 1]]);
    expect(flatSources(rows).map((r) => r.key)).toEqual(["agentwatch", "agentwatch/comms", "agentwatch/call_eval", "agentwatch/"]);
    expect(findingsOf(signals, rows[0].children[0])).toHaveLength(2);
    expect(findingsOf(signals, rows[0].children[2])).toHaveLength(1);
    expect(findingsOf(signals, rows[0])).toHaveLength(4);
  });

  test("busiest first: live before quiet before never", () => {
    const rows = buildSources({ signals: [sig("a.x", 3 * D), sig("b.y", H), sig("b.y", 2 * H), sig("c.z", H)], finders: [finder("a.x", "ax"), finder("d.w", "dw")], runs: [], now: NOW });
    expect(rows.map((r) => r.key)).toEqual(["b.y", "c.z", "a.x", "d.w"]);
  });
});

describe("a source's words", () => {
  test("kinds and names", () => {
    expect(sourceKind("sdk:union-errors")).toBe("errors");
    expect(sourceKind("union.escalation")).toBe("agent");
    expect(sourceKind("union.invariant")).toBe("check");
    expect(sourceKind("union.x", "comms")).toBe("judge");
    expect(sourceName("union.metric", [{ id: "goalDrift" }])).toBe("Goal drift");
    expect(sourceName("union.reply")).toBe("Reply");
  });
  test("severity from the field, else from the judge's words", () => {
    expect(severityOf({ severity: 4 })).toBe(4);
    expect(severityOf({ detail_md: "**Thing** (severity 8/10, execution_quality)" })).toBe(8);
    expect(severityOf({ detail_md: "nothing" })).toBeNull();
  });
  test("the first lines of a finding, plain and without its title again", () => {
    const md = "**Multiple personas pitched** (severity 8/10)\n\nQuinn and `Jordan` each sent it.\n\n> Following up on [the reply](http://x)\n```\ncode\n```\nfourth";
    expect(detailLines(md, "Multiple personas pitched")).toEqual(["Quinn and Jordan each sent it.", "Following up on the reply", "code"]);
    expect(detailLines(undefined, "x")).toEqual([]);
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

test("a source declared by one project in view is not undeclared where another files it", () => {
  const rows = buildSources({ signals: [sig("union.eval", 1000, { project_id: "p2" })], finders: [finder("union.eval", "evalReds", "p1"), finder("sentry", "errors", "p2")], runs: [], now: NOW });
  expect(rows.find((r) => r.key === "union.eval")?.undeclared).toBe(false);
});

test("a first line that repeats the title past a lead-in is dropped", () => {
  expect(detailLines("Union names no fee figure of its own.\nWhen asked, it named 1%.", "Not met: Union names no fee figure of its own")).toEqual(["When asked, it named 1%."]);
});

test("a source whose findings all name one judge has no child rows", () => {
  const rows = buildSources({ signals: [sig("judge:comms", 1000, { judge: "comms" }), sig("judge:comms", 2000, { judge: "comms" })], finders: [], runs: [], now: NOW });
  expect(rows[0].children).toEqual([]);
});
