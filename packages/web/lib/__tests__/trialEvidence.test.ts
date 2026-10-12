import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import { cardAsRead, evidenceGone, goneWhere } from "../trialEvidence";

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
