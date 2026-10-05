// The pure half of a project's expectations (the-line-model.md LM5): the
// proposal parser, the rule that lets a proposal apply on its own, applying a
// proposal as a new version, and the text a judge reads.
import { describe, expect, test } from "bun:test";
import { applyOps, autoApplies, expectationPrefix, parseProposal, renderExpectations, renderProposal, type Expectation, type ExpectationsVersion } from "./expectations";

const QUOTED = { kind: "call" as const, ref: "cl-96:58", quote: "the information should hold true", when: "2026-09-30" };
const BARE = { kind: "task" as const, ref: "ct-50340" };

const MARKDOWN = `# Two new lines from Monday's call
since: 2026-10-04T00:00:00Z
until: 2026-10-05T00:00:00Z

## add
part: Calls and callers
text: A call card's facts are true.
note: Contested on mechanism.
- call cl-96:718 (2026-09-30): "when we mint a call script and a brief, the information should hold true"
- commit um@0274603e1d

## retire ex-callers-call-9
reason: Replaced by the 1 to 5 bands.
- chat #team/j17npgbnv1p2thydwksxeqxmk18et2r5 (2026-09-28): "score against what the call was for"

## edit ex-callers-call-2
text: The card shows the last reply when it was not a yes.
- task ct-53607
`;

describe("parseProposal", () => {
  test("markdown: summary, window, and each change with its sources", () => {
    const p = parseProposal(MARKDOWN);
    expect(p.summary).toBe("Two new lines from Monday's call");
    expect(p.since).toBe(Date.parse("2026-10-04T00:00:00Z"));
    expect(p.until).toBe(Date.parse("2026-10-05T00:00:00Z"));
    expect(p.ops).toEqual([
      { op: "add", part: "Calls and callers", text: "A call card's facts are true.", note: "Contested on mechanism.", citations: [
        { kind: "call", ref: "cl-96:718", when: "2026-09-30", quote: "when we mint a call script and a brief, the information should hold true" },
        { kind: "commit", ref: "um@0274603e1d" },
      ] },
      { op: "retire", id: "ex-callers-call-9", reason: "Replaced by the 1 to 5 bands.", citations: [{ kind: "chat", ref: "#team/j17npgbnv1p2thydwksxeqxmk18et2r5", when: "2026-09-28", quote: "score against what the call was for" }] },
      { op: "edit", id: "ex-callers-call-2", text: "The card shows the last reply when it was not a yes.", citations: [{ kind: "task", ref: "ct-53607" }] },
    ]);
  });

  test("a chat source keeps its channel and message id in the ref", () => {
    const line = "## add\npart: P\ntext: T.\n- chat #team/j17abc (2026-10-01): \"said it\"";
    expect(parseProposal(line).ops[0].citations).toEqual([{ kind: "chat", ref: "#team/j17abc", when: "2026-10-01", quote: "said it" }]);
  });

  test("JSON is the same fields", () => {
    const p = parseProposal(JSON.stringify({ summary: "s", until: "2026-10-05", ops: [{ op: "add", part: "P", text: "T.", citations: [QUOTED], extra: 1 }] }));
    expect(p).toEqual({ summary: "s", until: Date.parse("2026-10-05"), ops: [{ op: "add", part: "P", text: "T.", citations: [QUOTED] }] });
  });

  test("refuses what cannot apply, naming every problem", () => {
    expect(() => parseProposal("## add\npart: P\ntext: T.")).toThrow(/op 1 \(add\): needs at least one source/);
    expect(() => parseProposal("## retire ex-a-1\n- task ct-1")).toThrow(/needs the reason/);
    expect(() => parseProposal("## edit not-an-id\ntext: x\n- task ct-1")).toThrow(/not an expectation id/);
    expect(() => parseProposal("## edit ex-a-1\n- task ct-1")).toThrow(/changes nothing/);
    expect(() => parseProposal("## add\npart: P\ntext: T.\n- tweet x")).toThrow(/kind "tweet"/);
    expect(() => parseProposal("## add\nwhat is this line\n- task ct-1")).toThrow(/line 2: cannot read/);
    expect(() => parseProposal("{ nope")).toThrow(/not valid JSON/);
    expect(() => parseProposal("until: tomorrow-ish\n## add\npart: P\ntext: T.\n- task ct-1")).toThrow(/not a time/);
  });

  test("an empty harvest is a proposal with no changes", () => {
    expect(parseProposal("# Nothing new\nuntil: 2026-10-05").ops).toEqual([]);
  });
});

describe("autoApplies", () => {
  test("only additions of active lines, each with a quoted, dated source", () => {
    expect(autoApplies([{ op: "add", part: "P", text: "T.", citations: [BARE, QUOTED] }])).toBe(true);
    expect(autoApplies([{ op: "add", part: "P", text: "T.", citations: [BARE] }])).toBe(false);
    expect(autoApplies([{ op: "add", part: "P", text: "T.", citations: [{ ...QUOTED, when: undefined }] }])).toBe(false);
    expect(autoApplies([{ op: "add", part: "P", text: "T.", citations: [QUOTED], status: "retired", reason: "r" }])).toBe(false);
    expect(autoApplies([{ op: "add", part: "P", text: "T.", citations: [QUOTED] }, { op: "edit", id: "ex-a-1", text: "x", citations: [QUOTED] }])).toBe(false);
    expect(autoApplies([])).toBe(false);
  });
});

describe("applyOps", () => {
  const seed = applyOps({ items: [], prefix: "callers", next_n: 1 }, [
    { op: "add", part: "Calls", text: "A card's facts are true.", citations: [QUOTED] },
    { op: "add", part: "Calls", text: "Short calls score a default 6.5.", citations: [BARE], status: "retired", reason: "Replaced by 1 to 5 bands." },
  ], 1, 0);

  test("version 1: stable ids from the prefix, retired lines kept with their reason", () => {
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    expect(seed.next_n).toBe(3);
    expect(seed.items.map((e) => [e.id, e.status, e.added_in, e.changed_in, e.retired_reason])).toEqual([
      ["ex-callers-1", "active", 1, 1, undefined],
      ["ex-callers-2", "retired", 1, 1, "Replaced by 1 to 5 bands."],
    ]);
  });

  test("an edit keeps the id, appends its sources and stamps the version; the old version's lines are untouched", () => {
    if (!seed.ok) throw new Error("seed");
    const v2 = applyOps({ items: seed.items, prefix: "callers", next_n: seed.next_n }, [
      { op: "edit", id: "ex-callers-1", text: "A card's facts are true, in English.", note: "Under review", citations: [BARE] },
      { op: "add", part: "Calls", text: "Callbacks happen when asked.", citations: [QUOTED] },
    ], 2, 1);
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    const line = v2.items.find((e) => e.id === "ex-callers-1")!;
    expect(line).toMatchObject({ text: "A card's facts are true, in English.", note: "Under review", added_in: 1, changed_in: 2 });
    expect(line.citations).toEqual([QUOTED, BARE]);
    expect(v2.items.at(-1)!.id).toBe("ex-callers-3");
    expect(seed.items[0].text).toBe("A card's facts are true.");
    expect(seed.items[0].citations).toEqual([QUOTED]);
  });

  test("refuses unknown ids, retired lines, twins and lines changed after the proposal's version", () => {
    if (!seed.ok) throw new Error("seed");
    const state = { items: seed.items, prefix: "callers", next_n: seed.next_n };
    const errors = (r: ReturnType<typeof applyOps>) => (r.ok ? [] : r.errors);
    expect(errors(applyOps(state, [{ op: "retire", id: "ex-callers-9", reason: "r", citations: [BARE] }], 2, 1))).toEqual(["op 1 (retire ex-callers-9): no such expectation"]);
    expect(errors(applyOps(state, [{ op: "edit", id: "ex-callers-2", text: "x", citations: [BARE] }], 2, 1))[0]).toMatch(/already retired/);
    expect(errors(applyOps(state, [{ op: "add", part: "Calls", text: "A CARD'S facts are true", citations: [QUOTED] }], 2, 1))[0]).toMatch(/already expected as ex-callers-1/);
    expect(errors(applyOps(state, [{ op: "retire", id: "ex-callers-1", reason: "r", citations: [BARE] }], 2, 0))[0]).toMatch(/changed in version 1, after the version 0/);
  });

  test("a retirement keeps the line and its sources, marked retired", () => {
    if (!seed.ok) throw new Error("seed");
    const r = applyOps({ items: seed.items, prefix: "callers", next_n: 3 }, [{ op: "retire", id: "ex-callers-1", reason: "Ruled out on sd-9.", citations: [BARE] }], 2, 1);
    expect(r.ok && r.items[0]).toMatchObject({ status: "retired", retired_reason: "Ruled out on sd-9.", changed_in: 2 });
  });
});

describe("rendering", () => {
  const items: Expectation[] = [
    { id: "ex-agent-quality-1", text: "The broker never denies an introduction it made.", part: "Broker conversations", status: "active", note: "Persona rule under review", citations: [QUOTED], added_in: 1, changed_in: 1 },
    { id: "ex-agent-quality-2", text: "Cold email names no buyers we lack.", part: "Cold email", status: "active", citations: [BARE], added_in: 1, changed_in: 1 },
    { id: "ex-agent-quality-3", text: "No introduction is described as free.", part: "Fees", status: "retired", retired_reason: "Oct 1 ruling", citations: [BARE], added_in: 1, changed_in: 1 },
  ];
  const doc: ExpectationsVersion = { project: { id: "p", title: "Agent Quality" }, version: 3, prefix: "agent-quality", items, applied_at: Date.parse("2026-10-05T10:00:00Z"), how: "person", summary: "s" };

  test("the judge's brief: active lines with ids under the version to cite, no sources, no retired lines", () => {
    const text = renderExpectations(doc, { brief: true });
    expect(text).toContain("Expectations for Agent Quality, version 3 (2026-10-05).");
    expect(text).toContain("names the id it breaks and version 3");
    expect(text).toContain("## Broker conversations\nex-agent-quality-1: The broker never denies an introduction it made.\n  note: Persona rule under review");
    expect(text).not.toContain("cl-96");
    expect(text).not.toContain("ex-agent-quality-3");
  });

  test("the full form adds sources and the retired lines with why", () => {
    const text = renderExpectations(doc);
    expect(text).toContain(`  - call cl-96:58 (2026-09-30): "the information should hold true"`);
    expect(text).toContain("## Retired (never graded against)\nex-agent-quality-3: No introduction is described as free.\n  retired in version 1: Oct 1 ruling");
  });

  test("a proposal shows an edit against the current words", () => {
    const text = renderProposal({ summary: "Sharpen B1", ops: [{ op: "edit", id: "ex-agent-quality-2", text: "Cold email describes the search.", citations: [QUOTED] }] }, items);
    expect(text).toContain("Was: Cold email names no buyers we lack.\nNow: Cold email describes the search.");
  });

  test("the prefix is the title's first two words", () => {
    expect(expectationPrefix("Callers & Call Management")).toBe("callers-call");
    expect(expectationPrefix("Broker / Private Network")).toBe("broker-private");
    expect(expectationPrefix("Infrastructure")).toBe("infrastructure");
    expect(expectationPrefix("!!")).toBe("project");
  });
});
