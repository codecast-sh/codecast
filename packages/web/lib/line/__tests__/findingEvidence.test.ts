import { describe, expect, test } from "bun:test";
import { findingSupport, isEmptyFinding, restsOnNothing } from "../findingEvidence";

const RULE = "A change to outbound cold email ships only after an A/B test shows it works as well as what it replaces.";
// ct-57470's findings as the store held them on 2026-10-13.
const stub = (attach: string, at: number) => ({
  title: RULE, source: "agentwatch", subject: "match", attach, created_at: at,
  detail_md: `**${RULE}** (severity 5/10, ex-matching-engine-1)\n\nplaceholder\n\n1 finding in this AgentWatch cluster (match judge).`,
});
const real = {
  title: `Not met: ${RULE.replace(/\.$/, "")}`, source: "agentwatch", subject: "ex-matching-engine-1", attach: "fingerprint", created_at: 3,
  detail_md: `**${RULE}** (severity 6/10, ex-matching-engine-1)\n\nUnion pitched Gadi to Elana as an Innovation Theater candidate.\n\n> The cleanest starting point would be to evaluate whether BoBo belongs in Innovation Theater\n\nBreaks expectation \`ex-matching-engine-1\`.\n\n2 findings in this AgentWatch cluster (match judge).`,
};

describe("findingEvidence", () => {
  test("a placeholder body is no evidence; a description or a quote is", () => {
    expect(isEmptyFinding(stub("new", 1))).toBe(true);
    expect(isEmptyFinding(real)).toBe(false);
    expect(isEmptyFinding({ title: "x", source: "agentwatch", detail_md: "> Good speaking today.\n\n1 finding in this AgentWatch cluster (comms judge)." })).toBe(false);
    expect(isEmptyFinding({ title: "x", source: "agentwatch", detail_md: "" })).toBe(true);
  });

  test("a problem opened by an empty finding rests on nothing, read from its description", () => {
    const description = `Opened by a bug report from AgentWatch.\n\nAbout: the match judge\n\nWhere it was seen: [Open in AgentWatch](https://admin.unionmatching.com/admin/agent-watch?cluster=09377460)\n\n**${RULE}** (severity 5/10, ex-matching-engine-1)\n\nplaceholder\n\n1 finding in this AgentWatch cluster (match judge).`;
    expect(restsOnNothing({ source: "signal", title: RULE, description })).toBe(true);
    // ct-58683: a person's report says what happened.
    expect(restsOnNothing({ source: "signal", title: "Call grader faulted Eric S", description: "Opened by a bug report from person.\n\nAbout: evaluate-call grader feedback\n\nCall 94373d15 (Oct 9 14:02Z, Eric S). Transcript: Eric referenced the four investor names" })).toBe(false);
    expect(restsOnNothing({ source: "manual", title: RULE, description })).toBe(false);
  });

  test("unsupported when its opener is empty, even with a later real finding attached to that title", () => {
    const rows = [stub("new", 1), stub("judge", 2), real];
    const s = findingSupport(rows);
    expect(s.unsupported).toBe(true);
    expect(s.empty.size).toBe(2);
    expect(findingSupport([{ ...real, attach: "new" }, stub("judge", 2)]).unsupported).toBe(false);
    expect(findingSupport([]).unsupported).toBe(false);
  });
});
