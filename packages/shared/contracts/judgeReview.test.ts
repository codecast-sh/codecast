import { describe, expect, test } from "bun:test";
import { caseDetail, caseRoute } from "./judgeReview";

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
