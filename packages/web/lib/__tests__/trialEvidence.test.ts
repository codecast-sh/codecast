import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import { cardAsRead, emptyWords, evidenceGone, goneWhere, priorArt, proposalAsRead, proposalUnfounded, ruleId, trialHold, trialLane, cardProse, cardsByProblem, overlapNote, reachSince, trialCardTab, trialReach, workTime } from "../trialEvidence";

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
    // Not nothing left, but not the person's either: its own case is gone, so it waits to be carded on a live one (tc-55, tc-44).
    expect(trialLane(cased)).toBe("held");
    expect(trialHold(cased)?.kind).toBe("recase");
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

  test("the why keeps the pair it was built with, the one the Reaches tile shows (tc-33: 5 of 19)", () => {
    const built = { ...card, reach: { conversations: 5, of: 19 }, recommend: { verdict: "revise" as const, why: "It works, but reaches only 5 of 19 conversations; the rest are other no-news emails." } };
    const read = cardAsRead({ card: built, evidence: { findings: 13, conversations: 12, withdrawn: 0, moved_to: [] }, coverage: { covered: 3, other: 9, fresh: 0, gone: 14 } })!;
    expect(read.recommend.why).toBe("It works, but reaches only 5 of 19 conversations; the rest are other no-news emails.");
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

describe("one count and one reading for a card (card fix round 10)", () => {
  const live = { findings: 22, conversations: 21, withdrawn: 0, moved_to: [] };
  const reached = { ...card, reach: { conversations: 19, of: 20, covers: [], read: [] } } as ChangeCard;

  test("the Reaches figure is the pair the card was asked with; what moved since is beside it (tc-75: 9 of 25, 0 new)", () => {
    const row = { card: { ...card, reach: { conversations: 9, of: 25, covers: [], read: [] } } as ChangeCard, coverage: { covered: 4, other: 7, fresh: 0, gone: 14 }, evidence: { ...live, conversations: 11 } };
    expect(trialReach(row)).toEqual({ covered: 9, of: 25, fresh: 0, gone: 14 });
    expect(reachSince(trialReach(row)!)).toBe("14 left");
  });

  test("the tile, the lead, the recommendation and the session's page say one pair (tc-69: 19 of 20, 1 new since)", () => {
    const row = { card: reached, coverage: { covered: 19, other: 1, fresh: 1, gone: 0 }, evidence: live };
    expect(trialReach(row)).toEqual({ covered: 19, of: 20, fresh: 1, gone: 0 });
    expect(reachSince(trialReach(row)!)).toBe("1 new");
    expect(reachSince(trialReach({ card: reached })!)).toBe("");
    // The session's words keep the figure it wrote, the one its published page states.
    expect(cardProse("The change reaches 19 of 20 conversations. Passes in all 20 versions.", row)).toBe("The change reaches 19 of 20 conversations. Passes in all 20 versions.");
    expect(cardAsRead({ ...row, card: { ...reached, recommend: { verdict: "ship", why: "It reaches 19 of 20 conversations." } } })!.recommend.why).toBe("It reaches 19 of 20 conversations.");
  });

  test("a fenced conversation reference reads as a link in a sentence and a quote block keeps one pair of marks (tc-71)", () => {
    const md = 'Union wrote:\n> "The possible value is a conversation."\n\n```view\nunion:conversation/cb68617d-1644-4c89-8637-f79622b888b3@2026-10-11T01:32:40Z\n```\nOn this branch: no email.';
    const out = cardProse(md);
    expect(out).not.toContain("```");
    expect(out).toContain("The conversation: union:conversation/cb68617d-1644-4c89-8637-f79622b888b3@2026-10-11T01:32:40Z");
    expect(out).toContain("> The possible value is a conversation.");
    // A line quoting two things keeps its marks.
    expect(cardProse('> "Yes" and then "No"')).toBe('> "Yes" and then "No"');
  });

  test("a card whose gate left the line is held, never waiting (tc-41 at ct-59540's proposal_gate)", () => {
    const row = { status: "waiting", kind: "gate", stale_gate: true, proposal: { risk: { class: "low", reason: "r" } }, evidence: { findings: 2, conversations: 2, withdrawn: 0, moved_to: [] } } as any;
    expect(trialHold(row)?.kind).toBe("stale_gate");
    expect(trialLane(row)).toBe("held");
    expect(trialLane({ ...row, stale_gate: false })).toBe("waiting");
  });

  test("an overlap line drops its own copy of the card id and any file reference; one that rules a conflict out is clear (tc-41)", () => {
    expect(overlapNote({ card: "tc-48", title: "t", how: "tc-48 makes a new broker reply cancel older queued outreach; this moves older notes up when an intro is queued. Different sends trigger them, so they cannot conflict." })).toEqual({ text: "Makes a new broker reply cancel older queued outreach; this moves older notes up when an intro is queued. Different sends trigger them, so they cannot conflict.", clear: true });
    expect(overlapNote({ card: "tc-64", title: "t", how: "Both cancel the older queued reply in sendEmail.ts:1468" })).toEqual({ text: "Both cancel the older queued reply", clear: false });
    expect(overlapNote({ card: "tc-55", title: "Should Union stay quiet?" })).toEqual({ text: "Should Union stay quiet?", clear: false });
  });

  test("working time reads in hours and minutes", () => {
    expect(workTime(41)).toBe("41 min");
    expect(workTime(130.4)).toBe("2 h 10 min");
    expect(workTime(120)).toBe("2 h");
  });
});

describe("/trial tabs add up to All, and a problem's cards are one row", () => {
  const row = (short_id: string, task_id: string, status: string, created_at: number, extra: object = {}) => ({ short_id, task_id, status, created_at, kind: "card", ...extra }) as any;
  test("every card is under exactly one tab: its lane, else answered or closed", () => {
    expect(trialCardTab(row("tc-1", "t1", "closed", 1))).toBe("closed");
    expect(trialCardTab(row("tc-2", "t1", "answered", 2))).toBe("answered");
    expect(trialCardTab(row("tc-3", "t1", "answered", 3, { rebuilding: true }))).toBe("running");
  });
  test("cards group by problem, newest leading, newest group first (ct-59338: tc-69 over tc-58, tc-51, tc-22)", () => {
    const g = cardsByProblem([row("tc-22", "a", "closed", 22), row("tc-69", "a", "waiting", 69), row("tc-71", "b", "waiting", 71), row("tc-51", "a", "answered", 51)]);
    expect(g.map((x) => x.map((c) => c.short_id))).toEqual([["tc-71"], ["tc-69", "tc-51", "tc-22"]]);
  });
});
