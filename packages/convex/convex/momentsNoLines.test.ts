// A judge with no lines (`parts: none`, judges.ts NO_LINES) under convex-test:
// it runs on its own prompt though its project has lines, files each finding
// into its project grouped under the judge, and a repeat of the same evidence
// finds the finding it filed before. The model and the embedding are stubbed at fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./_generated/api";
import { JUDGE, T0, setup, stubs, vec } from "./moments.testkit";

const SAYS = '{"deviations": [{"severity": 5, "what_happened": "A question went unanswered for days. Dana asked about Tuesday.", "quote": "Can we talk Tuesday?", "markers": ["unanswered"]}]}';

describe("a judge with no lines", () => {
  const s = stubs();
  beforeEach(() => s.install());
  afterEach(() => s.restore());

  test("runs on its own prompt, files what it finds, and a repeat finds its earlier finding", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    const judge = { ...JUDGE, parts: ["none"] };
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [judge] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });

    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [first] = await claim();
    s.state.judge = SAYS;
    s.state.vectors.push(vec(3));
    expect((await complete(first.moment, "t_1")).judged).toMatchObject([{ status: "ok", findings: 1, filed: 1 }]);
    const [finding] = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(finding).toMatchObject({ source: "judge:comms", subject: "comms", project_id: ids.project, title: "A question went unanswered for days." });
    expect(finding.fingerprint).toStartWith("evidence:");
    expect(finding.fingerprint).toContain(":@comms:");
    expect(finding.task_id).toBeDefined();
    const [run] = await t.run((ctx) => ctx.db.query("judge_runs").collect());
    expect(run.status).toBe("ok");
    // What the judge was sent: no expectations, and no id to cite.
    const sent = s.state.model.find((b) => String(b.system ?? "").includes("Read the conversation"))!;
    expect(JSON.stringify(sent.messages)).not.toContain("<expectations");
    expect(String(sent.system)).not.toContain('"expectation"');

    // The same words in a later moment of the same subject file nothing new: the key finds the finding.
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 + 60_000 }]);
    await due();
    const [second] = await claim();
    s.state.judge = SAYS;
    s.state.vectors.push(vec(3));
    expect((await complete(second.moment, "t_1")).judged).toMatchObject([{ status: "ok", findings: 1 }]);
    const all = await t.run((ctx) => ctx.db.query("signals").collect());
    expect(all.filter((x) => !x.retired)).toHaveLength(1);
    expect(all[0]!._id).toBe(finding._id);
  });

  test("a judge with lines still waits while its parts hold none", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [{ ...JUDGE, parts: ["Fees"] }] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = SAYS;
    expect((await complete(c.moment, "t_1")).judged).toMatchObject([{ status: "skipped", reason: "its projects have no expectations to grade against yet" }]);
  });
});
