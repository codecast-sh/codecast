import { describe, expect, test } from "bun:test";
import { caseDetail, caseGist, caseRoute } from "./judgeReview";

describe("caseRoute (learning-loop.md LL11)", () => {
  const product = { judge: "comms", source: "AgentWatch" };
  const codecast = { judge: "comms", source: "judge:comms", moment: "mo-4", moment_kind: "contact_thread", moment_source: "union-app" };

  test("misread goes to the judge, one key per judge wherever it lives", () => {
    expect(caseRoute(product, "misread")).toEqual({ against: "judge", key: "judge:agentwatch:comms", kind: "prompt_miss", title: "The comms judge misreads what it is shown", part: "the comms judge's prompt" });
    expect(caseRoute(codecast, "misread").key).toBe("judge:codecast:comms");
  });

  test("missing goes to the product's input builder, or to the extractor of the moment's kind", () => {
    expect(caseRoute(product, "missing")).toMatchObject({ against: "input", key: "judge-input:agentwatch:comms", kind: "bug", part: "what the comms judge is shown" });
    expect(caseRoute(codecast, "missing")).toMatchObject({ against: "extractor", key: "extractor:union-app:contact_thread", kind: "bug", title: "The contact_thread moments leave out facts a judge needs" });
    // A codecast judge's finding whose moment is gone still has a judge to file against.
    expect(caseRoute({ ...codecast, moment_kind: undefined }, "missing")).toMatchObject({ against: "input", key: "judge-input:codecast:comms" });
  });

  test("each case keys by its own finding, under its part; the title names the line the judge got wrong", () => {
    const line = { ...codecast, expectation: "ex-trial-15", expectation_text: "The broker never composes or queues mail on a match that was cancelled; it sends a close note.", finding: "sg-2590" };
    const misread = caseRoute(line, "misread");
    const missing = caseRoute(line, "missing");
    expect(misread).toMatchObject({ against: "judge", key: "judge:codecast:comms:sg-2590", kind: "prompt_miss", part: "the comms judge's prompt" });
    expect(missing).toMatchObject({ against: "extractor", key: "extractor:union-app:contact_thread:sg-2590", kind: "bug", part: "the contact_thread extractor" });
    // Two findings on one line are two cases until grouping finds them one fix.
    expect(caseRoute({ ...line, finding: "sg-2591" }, "misread").key).not.toBe(misread.key);
    expect(misread.title).toBe(`The comms judge marks good work as breaking "The broker never composes or queues mail on a match that was cancelled"`);
    expect(missing.title).toBe(`The contact_thread moments leave out a fact needed to judge "The broker never composes or queues mail on a match that was cancelled"`);
    expect(caseRoute({ ...line, expectation_text: undefined }, "misread").title).toBe("The comms judge marks good work as breaking ex-trial-15");
  });

  test("a case's gist is its moment, part, line, diagnosed fact and why it was missed", () => {
    const detail = "The comms judge found: x (sg-1)\n\nDiagnosis: the fact the judge needed was in what it saw, and it misread it.\nThe fact: M&A advisory is the paid lane.\nWhy it matters.";
    expect(caseGist({ moment: "mo-993", part: "the comms judge's prompt", expectation: "ex-8", detail_md: detail })).toBe("mo-993 · the comms judge's prompt · ex-8 · fact: M&A advisory is the paid lane. · why: Why it matters.");
    expect(caseGist({ moment: "mo-1", detail_md: "Diagnosis: x" })).toBe("mo-1");
  });

  test("the case reads on its own: what the judge said, why it was wrong, what the diagnosis found", () => {
    const text = caseDetail({
      judge: "comms", judge_version: "7", finding_short_id: "sg-4", finding_title: "Voicemail on a scheduled call",
      trigger: "dissolve", sentence: "The reply reports no problem about a call reaching voicemail.", answer: "missing", fact: "No call was scheduled.",
    });
    expect(text).toContain("The comms judge (version 7) found: Voicemail on a scheduled call (sg-4)");
    expect(text).toContain("A line run's proof found the system behaved well");
    expect(text).toContain("What a correct judgment of this moment does: The reply reports no problem about a call reaching voicemail.");
    expect(text).toContain("missing from what it saw");
    expect(text).toContain("The fact: No call was scheduled.");
  });
});
