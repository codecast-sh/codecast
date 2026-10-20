import { describe, expect, test } from "bun:test";
import { parseJudgeSpec } from "./judges";
import { agentFindingSignal, agentJudgePrompt, agentRunFinding, agentSimilarText, parseAgentFindings, transcriptFromStream } from "./agentJudges";
import type { MomentRecord } from "./moments";

const file = (header: string, body = "Review {{SUBJECT}} ({{WHO}}) as of {{NOW}}.\n<c>\n{{MOMENT}}\n</c>") => `---\n${header}\n---\n${body}`;

describe("an agent judge's header", () => {
  test("runner: agent makes it an agent judge, with defaults for what it leaves out", () => {
    const spec = parseJudgeSpec("review", file("moment: conversation\nprojects: Trial\nmodel: claude-opus-5-5\nmode: live\nrunner: agent\ncwd: app\nclaude_md: review/CLAUDE.md\ngateway: review/gateway.ts\ntimeout: 30m"));
    if ("error" in spec) throw new Error(spec.error);
    expect(spec.agent).toEqual({ tools: ["Bash", "Read", "Grep", "Glob"], cwd: "app", max_turns: 250, timeout_ms: 30 * 60_000, claude_md: "review/CLAUDE.md", gateway: "review/gateway.ts" });
  });

  test("a one-call judge has no agent, and its agent fields are refused without runner", () => {
    const plain = parseJudgeSpec("comms", file("moment: conversation\nprojects: Trial"));
    expect("error" in plain ? null : plain.agent).toBeUndefined();
    expect(parseJudgeSpec("comms", file("moment: conversation\nprojects: Trial\ncwd: app"))).toEqual({ error: "comms: cwd belong to an agent judge (runner: agent)" });
  });

  test("an agent judge gets no tool that writes, and no path out of the repo", () => {
    expect(parseJudgeSpec("r", file("moment: c\nprojects: T\nrunner: agent\ntools: Bash, Edit"))).toMatchObject({ error: expect.stringContaining("no tool that writes") });
    expect(parseJudgeSpec("r", file("moment: c\nprojects: T\nrunner: agent\ncwd: ../elsewhere"))).toMatchObject({ error: expect.stringContaining("cwd") });
    expect(parseJudgeSpec("r", file("moment: c\nprojects: T\nrunner: agent\nclaude_md: /etc/passwd"))).toMatchObject({ error: expect.stringContaining("claude_md") });
  });
});

const record = (o: Partial<MomentRecord> = {}): MomentRecord => ({
  kind: "conversation", subject: "c_1", event_at: Date.parse("2026-01-02T03:00:00Z"), extracted_at: Date.parse("2026-01-02T03:04:00Z"), gap_ms: 240_000,
  extractor: { path: "x", version: "v" }, refs: [], blocks: [{ type: "message", direction: "in", channel: "email", at: Date.parse("2026-01-02T03:00:00Z"), body: "Hello there" }], ...o,
});

describe("the review's first turn", () => {
  test("the moment's review page goes in whole, with who, the subject and the time its facts describe", () => {
    const text = agentJudgePrompt(file("x").split("---\n").pop()!, record({ review: "PAGE\n## Now\nIt is now Friday.", at: Date.parse("2026-01-02T03:04:30Z") }), "Ada Lovelace");
    expect(text).toBe("Review c_1 (Ada Lovelace) as of 2026-01-02 03:04 UTC.\n<c>\nPAGE\n## Now\nIt is now Friday.\n</c>");
  });

  test("without a page, the review reads the blocks as a one-call judge does", () => {
    expect(agentJudgePrompt("{{MOMENT}}", record(), null)).toContain("Hello there");
  });
});

describe("the findings turn's answer", () => {
  const reply = '```json\n{"findings": [{"what": "A promised callback never happened. Ada asked on Jan 1.", "evidence": [{"quote": "I will call you tomorrow", "message": "m_9", "run": "r_3"}], "hurt": "Ada waited", "severity": 8, "layer": "software", "cause": "The callback job skips contacts with no phone.", "cause_checked": true}, {"what": ""}, {"what": "x", "layer": "weird", "severity": 99}]}\n```';

  test("parses each finding, drops one with no words, and clamps what is out of range", () => {
    const f = parseAgentFindings(reply)!;
    expect(f).toHaveLength(2);
    expect(f[0]).toEqual({ what: "A promised callback never happened. Ada asked on Jan 1.", evidence: [{ quote: "I will call you tomorrow", message: "m_9", run: "r_3" }], hurt: "Ada waited", severity: 8, layer: "software", cause: "The callback job skips contacts with no phone.", cause_checked: true });
    expect(f[1]).toMatchObject({ layer: "both", severity: 10, cause_checked: false });
    expect(parseAgentFindings("no list here")).toBeNull();
  });

  test("files as a signal grouped under the judge, compared by its cause, keyed by the moment and its words", () => {
    const f = parseAgentFindings(reply)![0]!;
    const s = agentFindingSignal(f, { judge: "review", judge_version: "v1", moment: "mo-1", subject: "c_1" });
    expect(s).toMatchObject({ source: "judge:review", kind: "bug", title: "A promised callback never happened.", subject: "review", judge: "review", severity: 8, moment: "mo-1" });
    expect(s.similar_text).toBe(agentSimilarText(f));
    expect(s.similar_text.startsWith("Cause: The callback job")).toBe(true);
    expect(s.detail_md).toContain("> I will call you tomorrow\n(message m_9, run r_3)");
    expect(s.detail_md).toContain("**Cause (checked):**");
    expect(s.fingerprint).toBe(agentFindingSignal(f, { judge: "review", judge_version: "v2", moment: "mo-1", subject: "c_1" }).fingerprint);
    expect(s.fingerprint).not.toBe(agentFindingSignal(f, { judge: "review", judge_version: "v1", moment: "mo-2", subject: "c_1" }).fingerprint);
  });

  test("a run keeps it readable as a judge finding too", () => {
    expect(agentRunFinding(parseAgentFindings(reply)![0]!, "review")).toMatchObject({ expectation: "review", what_happened: "A promised callback never happened. Ada asked on Jan 1.", quote: "I will call you tomorrow", markers: ["software"] });
  });
});

test("a turn's stream reads back as what was said, run and returned", () => {
  const stream = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking." }, { type: "tool_use", name: "Bash", input: { command: "./xrun sql 'select 1'" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "1" }], is_error: false }] } },
    { type: "result", result: "done" },
  ].map((x) => JSON.stringify(x)).join("\n");
  expect(transcriptFromStream("the prompt", stream)).toEqual([
    { kind: "prompt", text: "the prompt" },
    { kind: "thinking", text: "hmm" },
    { kind: "text", text: "Looking." },
    { kind: "tool_use", name: "Bash", text: '{\n "command": "./xrun sql \'select 1\'"\n}' },
    { kind: "tool_result", text: "1" },
  ]);
});
