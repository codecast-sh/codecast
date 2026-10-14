// problem_page round 15: one wait has one age, station lines cut only at a sentence end, a finding about something
// else under a title that rests on nothing, and keeping such a problem goes through a review that names its run.
import { describe, expect, test } from "bun:test";
import { runVisits, type MapDecision, type MapRun } from "../lineMap";
import { decisionSaid } from "../lineModel";
import { offTopicFindings } from "../findingEvidence";
import { keepRealLedger } from "../../../components/consequential/ledgers";

describe("a person's step waits from when its decision was asked", () => {
  // ct-59338: sd-600 asked Oct 12 21:13 UTC; a resume restarted the decide node Oct 13 09:09 UTC.
  const asked = Date.UTC(2026, 9, 12, 21, 13);
  const restarted = Date.UTC(2026, 9, 13, 9, 9);
  const run = { _id: "r1", status: "paused", current_node_id: "decide", created_at: 0, updated_at: restarted,
    node_statuses: [{ node_id: "decide", status: "running", started_at: restarted }] } as unknown as MapRun;
  const decision = (over: Partial<MapDecision>) => ({ _id: "d1", status: "pending", workflow_run_id: "r1", gate_node_id: "decide", created_at: asked, ...over }) as MapDecision;
  const decide = (ds: MapDecision[]) => runVisits(run, undefined, ds).find((v) => v.node === "decide")!;

  test("the open decision's ask, not the node's restart", () => {
    expect(decide([decision({})]).startedAt).toBe(asked);
    expect(decide([decision({})]).at).toBe(asked);
  });
  test("without an open decision the node's own start stands", () => {
    expect(decide([]).startedAt).toBe(restarted);
    expect(decide([decision({ status: "withdrawn" })]).startedAt).toBe(restarted);
    expect(decide([decision({ workflow_run_id: "other" })]).startedAt).toBe(restarted);
  });
});

describe("a station's line is cut only at a sentence end", () => {
  const said = (reasoning: string) => decisionSaid({ reasoning, decided: { words: "Done", result: null } });
  const one = "The missed-call follow-up instructions still script \"tried you by phone\" openers and give the dial as the reason to send (red check 0/20 on main); the proposal carries forward the unmerged ct-57467 prompt rewrite, which turns the check 20/20.";
  test("one long sentence stays whole", () => {
    expect(one.length).toBeGreaterThan(240);
    expect(said(one)).toBe(one);
  });
  test("the sentences that fit after the first", () => {
    expect(said(`${one} It reaches 19 of 21.`)).toBe(one);
    expect(said(`Short one. ${"Second sentence words here. ".repeat(12)}`)).toMatch(/^Short one\. (Second sentence words here\. ?)+$/);
    expect(said(`Short one. ${"Second sentence words here. ".repeat(12)}`).length).toBeLessThanOrEqual(240);
  });
});

describe("a finding about something else under a title that rests on nothing", () => {
  const rule = "A change to outbound cold email ships only after an A/B test shows it works as well as what it replaces.";
  const stub = (id: string, attach: string) => ({ _id: id, title: rule, source: "agentwatch", subject: "match", attach, created_at: 1, detail_md: `**${rule}** (severity 5/10, x)\n\nplaceholder\n\n1 finding in this AgentWatch cluster (match judge).` });
  const gadi = { _id: "g", title: `Not met: ${rule}`, source: "agentwatch", subject: "x", attach: "fingerprint", created_at: 2, detail_md: `**${rule}** (severity 6/10, x)\n\nUnion pitched Gadi to Elana as an Innovation Theater candidate. The only need Gadi told us about is a Series A raise from investors.` };
  const onTopic = { ...gadi, _id: "e", detail_md: `**${rule}**\n\nThe new cold email went out to every contact without a test against the old one.` };

  test("ct-57470: the Gadi finding shares no subject word with the A/B rule", () => {
    expect([...offTopicFindings(rule, [stub("a", "new"), stub("b", "judge"), gadi])].map((r) => r._id)).toEqual(["g"]);
  });
  test("a finding that talks about the rule's subject stays on it", () => {
    expect(offTopicFindings(rule, [stub("a", "new"), onTopic]).size).toBe(0);
  });
  test("a supported problem is never judged", () => {
    expect(offTopicFindings(rule, [{ ...onTopic, attach: "new", created_at: 0 }, gadi]).size).toBe(0);
  });
});

describe("keeping an unsupported problem names the run it starts", () => {
  const base = { problem: "ct-57470", project: "Agent Quality", empty: 2, of: 3, cost: { billedUsd: 8, listUsd: 0, runs: 10, scope: "project" as const }, about: "31m" };
  test("starts now", () => {
    const l = keepRealLedger({ ...base, now: true, ahead: null, off: false });
    expect(l.figures.map((f) => `${f.value} ${f.label}`)).toEqual(["1 run starts now", "~$8 billed", "~31m until it asks you"]);
    expect(l.confirm).toBe("Keep it and start");
    expect(l.stop).toBe("Stop from its page");
    expect(l.rows.find((r) => r.k === "Findings")?.v).toBe("2 of 3 empty");
  });
  test("queued, and off", () => {
    expect(keepRealLedger({ ...base, now: false, ahead: 3, off: false }).figures[0]).toEqual({ value: "1", label: "run, after 3 queued" });
    const off = keepRealLedger({ ...base, now: false, ahead: null, off: true });
    expect(off.figures[0].value).toBe("0");
    expect(off.confirm).toBe("Keep it");
  });
});
