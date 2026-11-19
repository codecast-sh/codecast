import { describe, expect, test } from "bun:test";
import { heldCaseId, compactCases, deltaPhrase, expandCases, meanWithCi, normalizeGoalEnvs, pairedDelta, parseEnvResult, parseGoalEnvSpec, readEnvLink } from "./envs";

const base = {
  env: "union/second-side-replay",
  env_version: "g1",
  rung: "L2",
  candidate: { label: "base", sha: "abc1234" },
  split: "dev",
  cases: [{ id: "c1", score: 0.8, draws: 2, pass: null, note: "ok" }, { id: "c2", score: 0.4 }],
  summary: { n: 2, mean: 0.6, ci95: [0.2, 1], paired_delta: 0, paired_ci95: [0, 0] },
  noise: { aa_sd: 0.02, aa_runs: 3 },
  link: { to: "L4:matched_to_opted_in", measure: "auc", value: 0.66, n: 300, measured_at: "2026-11-17T00:00:00Z" },
  cost_usd: 0.42,
  started_at: "2026-11-17T10:00:00Z",
  finished_at: "2026-11-17T10:05:00Z",
};
const parse = (over: Record<string, unknown>, expect_ = {}) => parseEnvResult({ ...base, ...over }, expect_);
const errorOf = (out: ReturnType<typeof parseEnvResult>) => (out.ok ? null : out.error);

describe("parseEnvResult: the contract", () => {
  test("the draft's example reads whole, rung read as level, times as ms", () => {
    const out = parseEnvResult(JSON.stringify(base));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.level).toBe("L2");
    expect(out.result.started_at).toBe(Date.parse("2026-11-17T10:00:00Z"));
    expect(out.result.cases[0]).toEqual({ id: "c1", score: 0.8, draws: 2, pass: null, note: "ok" });
    expect(out.result.link).toMatchObject({ to: "L4:matched_to_opted_in", measure: "auc", value: 0.66, n: 300 });
    expect(out.warnings).toEqual([]);
  });

  test("level is accepted in place of rung; the two may not disagree", () => {
    const { rung: _r, ...noRung } = base;
    expect(parseEnvResult({ ...noRung, level: "L2" }).ok).toBe(true);
    expect(errorOf(parse({ level: "L3" }))).toMatch(/disagree/);
  });

  test("held: ids and scores only, nothing unknown anywhere", () => {
    const held = { split: "held", env_version: "9f3a2c1d", cases: [{ id: "c1", score: 0.8 }, { id: "c2", score: 0.4 }], link: undefined };
    expect(parse(held).ok).toBe(true);
    expect(errorOf(parse({ ...held, cases: [{ id: "c1", score: 0.8, note: "the pitch said..." }, { id: "c2", score: 0.4 }] }))).toMatch(/held-split case is its id and score only/);
    expect(errorOf(parse({ ...held, cases: [{ id: "c1", score: 0.8, draws: 1 }, { id: "c2", score: 0.4 }] }))).toMatch(/"draws"/);
    expect(errorOf(parse({ ...held, prompts: ["x"] }))).toMatch(/"prompts" a held-split result may not carry/);
    expect(errorOf(parse({ ...held, summary: { ...base.summary, examples: ["x"] } }))).toMatch(/"examples"/);
    expect(errorOf(parse({ ...held, candidate: { label: "base", prompt: "full text" } }))).toMatch(/"prompt"/);
  });

  test("held: no text rides in ids, versions, labels, shas or links (review H2, v2 item 2)", async () => {
    const held = { split: "held", env_version: "9f3a2c1d", cases: [{ id: "c1", score: 0.8 }, { id: "c2", score: 0.4 }], link: undefined };
    expect(parse(held).ok).toBe(true);
    expect(errorOf(parse({ ...held, env_version: "answer:refund-40-percent/cite.lease.clause.7" }))).toMatch(/env_version must be an opaque token \(a hex hash/);
    expect(errorOf(parse({ ...held, candidate: { label: "seller.in.divorce" } }))).toMatch(/candidate.label must be an opaque token \(base, a short id/);
    expect(parse({ ...held, candidate: { label: "ct-96178" } }).ok).toBe(true);
    expect(errorOf(parse({ ...held, link: base.link }))).toMatch(/held-split result carries no link/);
    // The registry takes only hashed held ids; cast env hashes them, the same way every run.
    expect(errorOf(parse(held, { heldIdsHashed: true }))).toMatch(/cases\[0\]\.id must be an opaque token \(h: and 16 hex/);
    const ids = await Promise.all(["Jane.Roe.12-Elm-St.wants.refund", "c2"].map((id) => heldCaseId("union/x", id)));
    expect(ids[0]).toMatch(/^h:[0-9a-f]{16}$/);
    expect(await heldCaseId("union/x", "Jane.Roe.12-Elm-St.wants.refund")).toBe(ids[0]);
    expect(parse({ ...held, cases: [{ id: ids[0], score: 0.8 }, { id: ids[1], score: 0.4 }] }, { heldIdsHashed: true }).ok).toBe(true);
    expect(errorOf(parse({ ...held, cases: [{ id: "Customer Jane Roe at 12 Elm St asked to cancel", score: 0.8 }, { id: "c2", score: 0.4 }] }))).toMatch(/cases\[0\]\.id must be an opaque token/);
    expect(parse({ ...held, cases: [{ id: "pitch:8f3a2c", score: 0.8 }, { id: "c2", score: 0.4 }] }).ok).toBe(true);

    expect(errorOf(parse({ ...held, candidate: { label: "base", sha: "not a sha at all" } }))).toMatch(/candidate.sha must be an opaque token \(hex\)/);

    expect(errorOf(parse({ ...held, summary: { n: 2, mean: 0.6, baseline: { label: "base", mean: 0.5, text: "x" } } }))).toMatch(/summary.baseline has a field "text"/);
    expect(errorOf(parse({ link: { ...base.link, evidence: "the five pitches where she said yes" } }))).toMatch(/link.evidence must be an opaque token/);
  });

  test("the summary is held to its cases (review M2), and times to this century (L2)", () => {
    expect(errorOf(parse({ cases: [], summary: { n: 5000, mean: 0.99 } }))).toMatch(/only for L4 and L5/);
    const out = parse({ summary: { n: 2, mean: 0.6, ci95: [0.59, 0.61] } });
    expect(out.ok && out.result.summary.ci95).toEqual([0, 1]);
    expect(errorOf(parse({ summary: { n: 2, mean: 0.6, ci95: [-50, 0.1] } }))).toMatch(/within \[0, 1\]/);
    expect(errorOf(parse({ summary: { n: 2, mean: 0.6, unscored: 999999 } }))).toMatch(/unscored is over/);
    expect(errorOf(parse({ summary: { n: 2, mean: 0.6, paired_delta: 1e300 } }))).toMatch(/paired_delta must lie within/);
    expect(errorOf(parse({ summary: { n: 2, mean: 0.6, paired_ci95: [5, 6] } }))).toMatch(/within \[-1, 1\]/);
    expect(errorOf(parse({ started_at: 1_794_000_000, finished_at: 1_794_000_100 }))).toMatch(/before 2001/);
  });

  test("dev: an unknown field is dropped with a warning, not refused", () => {
    const out = parse({ diagnostics: { x: 1 } });
    expect(out.ok && out.warnings).toEqual(['the result: ignored unknown field "diagnostics"']);
  });

  test("malformed results name what is wrong", () => {
    expect(errorOf(parseEnvResult("{"))).toMatch(/not JSON/);
    expect(errorOf(parseEnvResult([]))).toMatch(/one JSON object/);
    expect(errorOf(parse({ env: "NoSlash" }))).toMatch(/<product>\/<name>/);
    expect(errorOf(parse({ rung: "L9" }))).toMatch(/L0, L1/);
    expect(errorOf(parse({ split: "test" }))).toMatch(/split must be/);
    expect(errorOf(parse({ cases: [{ id: "c1", score: 1.2 }, { id: "c2", score: 0 }], summary: { n: 2, mean: 0.6 } }))).toMatch(/between 0 and 1/);
    expect(errorOf(parse({ cases: [{ id: "c1", score: 0.8 }, { id: "c1", score: 0.4 }] }))).toMatch(/appears twice/);
    expect(errorOf(parse({ summary: { n: 3, mean: 0.6 } }))).toMatch(/summary.n is 3 but cases has 2/);
    expect(errorOf(parse({ summary: { n: 2, mean: 0.9 } }))).toMatch(/not the mean/);
    expect(errorOf(parse({ summary: { n: 2, mean: 0.6, ci95: [0.9, 0.1] } }))).toMatch(/lo above hi/);
    expect(errorOf(parse({ finished_at: "2026-11-17T09:00:00Z" }))).toMatch(/before started_at/);
    expect(errorOf(parse({ started_at: "yesterday" }))).toMatch(/ISO time/);
    expect(errorOf(parse({ cost_usd: -1 }))).toMatch(/negative/);
    expect(errorOf(parse({ link: { ...base.link, to: "L1:union/gate" } }))).toMatch(/not above L2/);
    expect(errorOf(parse({ candidate: {} }))).toMatch(/candidate.label/);
  });

  test("a result for another env, level or split than was asked for is refused", () => {
    expect(errorOf(parse({}, { env: "union/other" }))).toMatch(/was run/);
    expect(errorOf(parse({}, { level: "L1" }))).toMatch(/declared at L1/);
    expect(errorOf(parse({}, { split: "held" }))).toMatch(/held split was asked for|but held was asked for/);
  });

  test("a level with no cases (an experiment readout) files a summary alone", () => {
    expect(parse({ rung: "L4", cases: [], summary: { n: 340, mean: 0.62 }, link: undefined }).ok).toBe(true);
    expect(errorOf(parse({ rung: "L4", cases: [], summary: { n: 340, mean: 0.1, ci95: [0.9, 0.95] }, link: undefined }))).toMatch(/outside its ci95/);
  });
});

describe("cases, stats, goal envs", () => {
  test("cases round-trip compactly", () => {
    const cases = [{ id: "a", score: 1 }, { id: "b", score: 0.5, draws: 3 }, { id: "c", score: 0, draws: 1, pass: false, note: "n" }];
    expect(compactCases(cases)).toEqual([["a", 1], ["b", 0.5, 3], ["c", 0, 1, false, "n"]]);
    expect(expandCases(compactCases(cases))).toEqual(cases);
  });

  test("paired delta pairs by id and reads its interval", () => {
    const b = [0.5, 0.6, 0.4, 0.5, 0.7].map((score, i) => ({ id: `c${i}`, score }));
    const c = b.map((x) => ({ id: x.id, score: x.score + 0.1 })).concat({ id: "new", score: 1 });
    const d = pairedDelta(b, c);
    expect(d).toMatchObject({ n: 5, delta: 0.1, only_base: 0, only_candidate: 1 });
    expect(d.ci95![0]).toBeCloseTo(0.1, 6);
    expect(deltaPhrase(d)).toMatch(/^\+0\.100 \[\+0\.100, \+0\.100\] over 5 cases, better/);
    const flat = pairedDelta(b, b.map((x, i) => ({ id: x.id, score: x.score + (i % 2 ? 0.05 : -0.05) })));
    expect(deltaPhrase(flat)).toMatch(/within noise/);
    expect(meanWithCi([1])).toEqual({ n: 1, mean: 1 });
    // At L0 one case that broke is a regression, whatever the interval says.
    const broke = pairedDelta(Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, score: 1 })), Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, score: i ? 1 : 0 })));
    expect(deltaPhrase(broke)).toMatch(/within noise; 1 case worse, 0 better$/);
    expect(deltaPhrase(broke, undefined, "L0")).toMatch(/over 30 cases, worse; 1 case worse, 0 better$/);
    // A pass rate of 30/30 is not certain: Wilson, not a zero-width t interval.
    expect(meanWithCi(Array(30).fill(1))).toEqual({ n: 30, mean: 1, ci95: [0.8865, 1] });
    expect(meanWithCi([1, 0, 1, 1]).ci95).toEqual([0.3006, 0.9544]);
    expect(pairedDelta([{ id: "a", score: 1 }, { id: "b", score: 0 }], [{ id: "a", score: 1 }, { id: "b", score: 0 }])).toMatchObject({ delta: 0, ci95: [0, 0] });
    expect(deltaPhrase(pairedDelta([{ id: "a", score: 1 }, { id: "b", score: 0.5 }, { id: "c", score: 0.5 }], [{ id: "b", score: 0.5 }, { id: "c", score: 0.5 }]), undefined, "L0")).toMatch(/worse; 1 base case missing on the branch$/);
    expect(deltaPhrase(pairedDelta([{ id: "a", score: 0 }], [{ id: "a", score: 1 }]))).toMatch(/too few cases/);
  });

  test("goal env specs and lists", () => {
    expect(parseGoalEnvSpec("L2=union/replay")).toEqual({ env: "union/replay", level: "L2" });
    expect(parseGoalEnvSpec("union/replay", () => "L3")).toEqual({ env: "union/replay", level: "L3" });
    expect(parseGoalEnvSpec("union/replay")).toEqual({ error: expect.stringMatching(/names no level/) });
    expect(parseGoalEnvSpec("L2=bad key")).toEqual({ error: expect.stringMatching(/not L<n>=/) });
    expect(normalizeGoalEnvs([{ env: "a/x", level: "L3" }, { env: "a/y", level: "L0" }, { env: "a/z", level: "L3" }])).toEqual([{ env: "a/y", level: "L0" }, { env: "a/x", level: "L3" }, { env: "a/z", level: "L3" }]);
    expect(normalizeGoalEnvs([{ env: "a/x", level: "L3" }, { env: "a/x", level: "L1" }])).toEqual({ error: "a/x is named twice" });
    expect(readEnvLink({ to: "L5:intros", measure: "rank", value: 0.5, n: 4 }, "L4").ok).toBe(true);
    expect(readEnvLink({ to: "L5:intros", measure: "Rank!", value: 0.5, n: 4 }).ok).toBe(false);
  });
});

describe("case pages", () => {
  test("pages are bounded by characters and rows, cut the same way every time, and join back to the cases", () => {
    const { ENV_CASE_PAGE, casePageHash, compactCasePages, expandCases } = require("./envs");
    const wide = Array.from({ length: 1200 }, (_, i) => ({ id: `p/${i}/${"x".repeat(80)}`, score: 1 }));
    const pages: string[] = compactCasePages(wide);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.length <= ENV_CASE_PAGE.chars)).toBe(true);
    expect(pages.flatMap((p) => expandCases(JSON.parse(p)))).toEqual(wide);
    expect(compactCasePages(wide)).toEqual(pages);
    const narrow: string[] = compactCasePages(Array.from({ length: 1001 }, (_, i) => ({ id: `${i}`, score: 0 })));
    expect(narrow.map((p) => JSON.parse(p).length)).toEqual([500, 500, 1]);
    expect(compactCasePages([])).toEqual(["[]"]);
    expect(casePageHash(pages[0])).toMatch(/^[0-9a-f]{16}$/);
    expect(casePageHash(pages[0])).toBe(casePageHash(pages[0]));
    expect(casePageHash(pages[0])).not.toBe(casePageHash(pages[1]));
  });
});
