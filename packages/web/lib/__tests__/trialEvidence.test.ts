import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import { cardAsRead, evidenceGone, goneWhere, priorArt, proposalUnfounded, ruleId, trialHold, trialLane } from "../trialEvidence";

const card: ChangeCard = { ...JSON.parse(readFileSync(join(import.meta.dir, "../../../shared/contracts/__fixtures__/changeCard/card.json"), "utf-8")), recommend: { verdict: "ship", why: "The fix works." } };

test("a card on a problem with findings reads as written; an older backend with no evidence is not stale", () => {
  expect(cardAsRead({ card, evidence: { findings: 3, conversations: 2, withdrawn: 0, moved_to: [] } })).toBe(card);
  expect(cardAsRead({ card, evidence: undefined })).toBe(card);
  expect(evidenceGone(undefined)).toBe(false);
});

test("a Ship card whose problem was emptied recommends Drop and names where the evidence went (tc-18)", () => {
  const read = cardAsRead({ card, evidence: { findings: 0, conversations: 0, withdrawn: 2, moved_to: ["ct-59425"] } })!;
  expect(read.recommend.verdict).toBe("drop");
  expect(read.recommend.why).toContain("ct-59425");
  expect(goneWhere({ findings: 0, conversations: 0, withdrawn: 2, moved_to: ["ct-59425"] })).toBe("moved to ct-59425");
  expect(goneWhere({ findings: 0, conversations: 0, withdrawn: 5, moved_to: [] })).toBe("none held when judged again");
});

test("an evidence-gone Drop says its own why, marked so no surface shows the author's check chips as the reason (tc-14)", () => {
  const read = cardAsRead({ card, evidence: { findings: 0, conversations: 0, withdrawn: 5, moved_to: [], gone: [{ short_id: "sg-1", title: "t", at: 1, fate: "rejudged" }] } })!;
  expect(read.recommend.source).toBe("evidence");
  expect(read.recommend.why).toContain("none held when judged again");
  expect(goneWhere({ findings: 0, conversations: 0, withdrawn: 1, moved_to: [], gone: [{ short_id: "sg-1", title: "t", at: 1, fate: "duplicate" }] })).toBe("copies of findings on closed problems");
});

describe("which lane a waiting card sits in on /trial", () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    kind: "proposal", question: "Q?", today: "t", after: "a", cause: { line: "l", where: ["x.ts:1"] },
    case: { signal: "sg-1", asked: "a", quote: "" }, risk: { class: "review", reason: "r" }, proof: { rung: "replay", outcome: "red" }, ...over,
  });
  const row = (over: Record<string, unknown>) => ({ status: "waiting", evidence: { findings: 3, conversations: 3, withdrawn: 0, moved_to: [] }, cited: [{ signal: "sg-1", state: "live" }], ...over }) as any;

  test("judge and extractor fixes are our tooling, not the executive's queue (tc-24, tc-25)", () => {
    expect(trialLane(row({ proposal: proposal(), tooling: "judge" }))).toBe("tooling");
    expect(trialLane(row({ proposal: proposal() }))).toBe("waiting");
  });

  test("one conversation behind a change that reaches many waits for a second (tc-21)", () => {
    const one = row({ proposal: proposal(), evidence: { findings: 1, conversations: 1, withdrawn: 0, moved_to: [] } });
    expect(trialLane(one)).toBe("held");
    expect(trialHold(one)?.kind).toBe("one_case");
    expect(trialLane({ ...one, proposal: proposal({ risk: { class: "low", reason: "r" } }) })).toBe("waiting");
  });

  test("a proposal whose case left the problem and whose proof never showed the miss has nothing behind it (tc-26's first run)", () => {
    const gone = row({ proposal: proposal({ proof: undefined }), cited: [{ signal: "sg-1", state: "withdrawn", fate: "rejudged" }] });
    expect(trialLane(gone)).toBe("empty");
    expect(proposalUnfounded(gone)).toBe("No case on file; the proof never finished");
    expect(trialLane({ ...gone, proposal: proposal() })).toBe("waiting");
  });

  test("a change card on a stale base is rebuilding, not a decision (tc-3, tc-6)", () => {
    const card = { checks: [{ name: "Up to date", ok: false, detail: "Rebuild on main: 382 commits behind" }] };
    expect(trialLane(row({ card }))).toBe("held");
    expect(trialHold(row({ card }))?.words).toBe("Rebuilding on main");
  });

  test("prior art names the problem a fix builds on", () => {
    expect(priorArt("ct-59425 origin/codecast/agentwatch-trial-ct-59425 1eadcef23a: still red with it applied (3 of 6 draws)")).toEqual({ ref: "ct-59425", saw: "still red with it applied (3 of 6 draws)" });
    expect(ruleId("ex-agentwatch-trial-20")).toBe("ex-20");
  });
});
