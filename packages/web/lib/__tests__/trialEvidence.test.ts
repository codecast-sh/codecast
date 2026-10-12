import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import { cardAsRead, emptyWords, evidenceGone, goneWhere, priorArt, proposalAsRead, proposalUnfounded, ruleId, trialHold, trialLane } from "../trialEvidence";

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

  test("a judge fix measured on too few kept findings is held with the count, not put in our tooling queue (tc-38, tc-39)", () => {
    const ab = (verdict: string, moments: number) => ({ verdict, controls: { moments, runs: moments * 5, base: 14, arm: 11, p: 0.98 }, ruled: { moments: 1, runs: 5, base: 5, arm: 0, p: 0.004 }, reps: 5, model: "m", cost_usd: 0.5 });
    const thin = row({ tooling: "judge", judge_fix: { ab: ab("few_controls", 3) } });
    expect(trialLane(thin)).toBe("held");
    expect(trialHold(thin)).toEqual({ kind: "controls", words: "3 of 10 kept-finding moments · rerun when there are more" });
    expect(trialLane(row({ tooling: "judge", judge_fix: { ab: ab("better", 10) } }))).toBe("tooling");
  });

  test("one conversation behind a change that reaches many waits for a second (tc-21)", () => {
    const one = row({ proposal: proposal(), evidence: { findings: 1, conversations: 1, withdrawn: 0, moved_to: [] } });
    expect(trialLane(one)).toBe("held");
    expect(trialHold(one)?.kind).toBe("one_case");
    expect(trialLane({ ...one, proposal: proposal({ risk: { class: "low", reason: "r" } }) })).toBe("waiting");
    // A built change on one conversation at Medium risk waits the same way (tc-18).
    const built = row({ card: { checks: [], risk: { class: "review", reason: "r" }, recommend: { verdict: "revise", why: "w" } }, evidence: { findings: 1, conversations: 1, withdrawn: 0, moved_to: [] } });
    expect(trialHold(built)?.kind).toBe("one_case");
    expect(trialLane({ ...built, card: { ...built.card, risk: { class: "low", reason: "r" } } })).toBe("waiting");
    // With no conversation left it is nothing to hold: it reads as gone, not as waiting for a second.
    const gone = { ...built, evidence: { findings: 0, conversations: 0, withdrawn: 0, moved_to: ["ct-59425"] } };
    expect(trialHold(gone)).toBeNull();
    expect(trialLane(gone)).toBe("empty");
  });

  test("a proposal whose own author recommends waiting is held, not asked, even on two conversations (tc-23)", () => {
    const wait = row({ proposal: proposal({ recommend: { verdict: "wait", why: "A replay of the 19 found pairs would settle it." } }), evidence: { findings: 2, conversations: 2, withdrawn: 0, moved_to: [] } });
    expect(trialLane(wait)).toBe("held");
    expect(trialHold(wait)?.kind).toBe("wait");
    expect(trialLane({ ...wait, proposal: proposal({ recommend: { verdict: "build", why: "w" } }) })).toBe("waiting");
  });

  test("a proposal whose case left an emptied problem and whose proof never showed the miss has nothing behind it (tc-26's first run)", () => {
    const gone = row({ proposal: proposal({ proof: undefined }), cited: [{ signal: "sg-1", state: "withdrawn", fate: "rejudged" }], evidence: { findings: 0, conversations: 0, withdrawn: 1, moved_to: [] } });
    expect(trialLane(gone)).toBe("empty");
    expect(proposalUnfounded(gone)).toBe("No case on file; the proof never finished");
    expect(proposalUnfounded({ ...gone, proposal: proposal() })).toBeNull();
  });

  test("a proposal is not 'nothing left' while its problem still holds a finding, or when the run measured the miss itself (tc-41)", () => {
    // tc-41: its cited case was judged away, but ct-59540 still holds sg-2652, and the run counted 10 of 214 intros.
    const cased = row({ proposal: proposal({ proof: undefined, risk: { class: "low", reason: "r" } }), cited: [{ signal: "sg-1", state: "withdrawn", fate: "rejudged" }], evidence: { findings: 1, conversations: 1, withdrawn: 0, moved_to: [] } });
    expect(proposalUnfounded(cased)).toBeNull();
    expect(trialLane(cased)).toBe("waiting");
    const measured = { count: 10, of: 214, window: "60 days of intro sends", method: "production-read" };
    const emptied = { ...cased, evidence: { findings: 0, conversations: 0, withdrawn: 1, moved_to: [] } };
    expect(trialLane(emptied)).toBe("empty");
    expect(trialLane({ ...emptied, proposal: proposal({ proof: undefined, risk: { class: "low", reason: "r" }, measured }) })).toBe("waiting");
    expect(trialLane({ ...emptied, proposal: proposal({ proof: undefined, risk: { class: "low", reason: "r" }, measured: { ...measured, count: 0 } }) })).toBe("empty");
    // A measured count of more than one case is more than one conversation: no one-case hold at Medium risk.
    const one = row({ proposal: proposal({ measured }), evidence: { findings: 1, conversations: 1, withdrawn: 0, moved_to: [] } });
    expect(trialHold(one)).toBeNull();
    expect(trialHold({ ...one, proposal: proposal() })?.kind).toBe("one_case");
  });

  test("a change card on a stale base is held as behind main, never said to be rebuilding while nothing runs (tc-3, tc-6, tc-14)", () => {
    const card = { checks: [{ name: "Up to date", ok: false, detail: "Rebuild on main: 382 commits behind" }] };
    expect(trialLane(row({ card }))).toBe("held");
    expect(trialHold(row({ card }))).toEqual({ kind: "stale", words: "Behind main · rebuild before asking" });
    // A rebuild actually running is its own lane.
    expect(trialLane(row({ card, rebuilding: { node: "rebase" } }))).toBe("running");
    // tc-14: stale and emptied reads as its drop in Nothing left.
    const emptied = row({ card, evidence: { findings: 0, conversations: 0, withdrawn: 3, moved_to: [] } });
    expect(trialLane(emptied)).toBe("empty");
    expect(emptyWords(emptied)).toBe("Drop: evidence gone");
  });

  test("a proposal with nothing left behind it and no count reads Not now, not its author's Build it (tc-44)", () => {
    const gone = { findings: 0, conversations: 0, withdrawn: 10, moved_to: [], gone: [{ short_id: "sg-2715", title: "t", at: 1, fate: "rejudged" as const }] };
    const build = proposal({ recommend: { verdict: "build", why: "w" } }) as any;
    expect(proposalAsRead(build, gone)?.recommend).toMatchObject({ verdict: "wait" });
    expect(proposalAsRead(build, gone)?.recommend?.why).toContain("none held when judged again");
    const counted = { ...build, measured: { count: 61, of: 66, window: "cc'd parties since September", method: "replay" } };
    expect(proposalAsRead(counted, gone)).toBe(counted);
    expect(trialLane(row({ proposal: counted, evidence: gone, cited: [{ signal: "sg-1", state: "withdrawn" }] }))).toBe("waiting");
  });

  test("the why's conversation pair reads the same live pair as the Conversations tile (tc-33: 5 of 19 built, 3 of 12 now)", () => {
    const built = { ...card, reach: { conversations: 5, of: 19 }, recommend: { verdict: "revise" as const, why: "It works, but reaches only 5 of 19 conversations; the rest are other no-news emails." } };
    const read = cardAsRead({ card: built, evidence: { findings: 13, conversations: 12, withdrawn: 0, moved_to: [] }, coverage: { covered: 3, other: 9, fresh: 0, gone: 14 } })!;
    expect(read.recommend.why).toBe("It works, but reaches only 3 of 12 conversations; the rest are other no-news emails.");
  });

  test("a Ship that owes evals the trial never runs waits on the person, the evals a fact on it, never a lane it cannot leave (tc-58, tc-9)", () => {
    const owing = row({ card: { ...card, checks: [{ name: "Eval", ok: true, detail: "Unscored: this project's line has no eval command, so no eval replayed the changed prompt" }] }, evals_owed: ["core", "matching"] });
    expect(trialHold(owing)).toBeNull();
    expect(trialLane(owing)).toBe("waiting");
  });

  test("a proposal gate with no proposal card is held for its words station, never put to a person as markdown (tc-54)", () => {
    const bare = row({ kind: "gate", node_id: "proposal_gate", card: undefined, doc_md: "# Proposal\n```ts\n...```" });
    expect(trialHold(bare)?.kind).toBe("uncarded");
    expect(trialLane(bare)).toBe("held");
    expect(trialLane({ ...bare, tooling: "judge" })).toBe("tooling");
  });

  test("a proposal's count taken before its problem was regrouped is held to be taken again (tc-57: 47 of 53 over the old 73 findings)", () => {
    const counted = proposal({ measured: { count: 47, of: 53, window: "14 days", method: "production-read" }, recommend: { verdict: "build", why: "w" } }) as any;
    const live = { findings: 36, conversations: 36, withdrawn: 0, moved_to: [] };
    expect(trialHold(row({ kind: "gate", card: undefined, proposal: counted, evidence: live, regrouped: true }))).toEqual({ kind: "remeasure", words: "Regrouped after its count · re-ask to remeasure" });
    expect(trialLane(row({ kind: "gate", card: undefined, proposal: counted, evidence: live, regrouped: false }))).toBe("waiting");
  });

  test("a Ship covering none of the problem's conversations now reads Revise, so it is the person's call again (tc-32)", () => {
    const read = cardAsRead({ card, evidence: { findings: 13, conversations: 9, withdrawn: 0, moved_to: [] }, coverage: { covered: 0, other: 7, fresh: 2, gone: 3 } })!;
    expect(read.recommend).toMatchObject({ verdict: "revise", source: "evidence" });
    expect(read.recommend.why).toContain("9 conversations are left");
    expect(trialLane(row({ card, evals_owed: ["gate"], coverage: { covered: 0, other: 7, fresh: 2, gone: 3 } }))).toBe("waiting");
  });

  test("prior art names the problem a fix builds on", () => {
    expect(priorArt("ct-59425 origin/codecast/agentwatch-trial-ct-59425 1eadcef23a: still red with it applied (3 of 6 draws)")).toEqual({ ref: "ct-59425", saw: "still red with it applied (3 of 6 draws)" });
    expect(ruleId("ex-agentwatch-trial-20")).toBe("ex-20");
  });
});
