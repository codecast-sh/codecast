import { describe, expect, test } from "bun:test";
import { handoffBranches, handoffPrRefs, strandedHandoff, type StrandedFacts } from "./strandedHandoff";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const facts = (over: Partial<StrandedFacts> = {}): StrandedFacts => ({
  status: "in_review",
  execution_status: "done",
  handoff: { at: NOW - 4 * DAY, text: "Handoff: done\n\nBranch acme/fix-a, tests green.", conversation_id: "jx1" },
  guide_at: null,
  files_changed: 0,
  landings: [],
  prs: [],
  linked_prs: [],
  ...over,
});

describe("handoff text", () => {
  test("pull requests: the PR line, a URL in the evidence, and PR #N; never a bare #N", () => {
    const text = "Handoff: done\n\nRebased after #3 landed. Also PR #5.\n\nPR: https://github.com/Acme/App/pull/4";
    expect(handoffPrRefs(text, "https://github.com/Acme/App/pull/4")).toEqual([{ repository: "acme/app", number: 4 }, { number: 5 }]);
  });

  test("the PR line as `cast task handoff --pr '#21'` writes it", () => {
    expect(handoffPrRefs("Handoff: done\n\nverified\n\nPR: #21", "#21")).toEqual([{ number: 21 }]);
  });

  test("a PR #N the URL already names is one pull request", () => {
    expect(handoffPrRefs("PR #12 https://github.com/a/b/pull/12")).toEqual([{ repository: "a/b", number: 12 }]);
  });

  test("branches hold a slash and start with a letter; tallies are not branches", () => {
    expect(handoffBranches("Branch someone/ct-1-fix at abc1234. branch 24/24 green. on branch `acme/fix-b`.")).toEqual([
      "someone/ct-1-fix",
      "acme/fix-b",
    ]);
  });

  test("the default branch is where work goes, not a branch it sits on", () => {
    expect(handoffBranches("Rebased on branch origin/main, then branch upstream/master.")).toEqual([]);
    expect(strandedHandoff(facts({ handoff: { at: NOW - 4 * DAY, text: "Handoff: done\n\nChecked against branch origin/main" } }), NOW)).toBeNull();
  });
});

describe("strandedHandoff", () => {
  test("a finished handoff with a branch, in review past the wait, is stranded", () => {
    expect(strandedHandoff(facts(), NOW)).toEqual({ handed_off_at: NOW - 4 * DAY, handed_off_by: "jx1", branches: ["acme/fix-a"], prs: [] });
  });

  test("not before the wait has passed", () => {
    expect(strandedHandoff(facts(), NOW, 5)).toBeNull();
  });

  test("only in_review: done is a person's claim it landed", () => {
    expect(strandedHandoff(facts({ status: "done" }), NOW)).toBeNull();
    expect(strandedHandoff(facts({ status: "in_progress" }), NOW)).toBeNull();
  });

  test("only finished handoffs: a blocked one stopped, it did not finish", () => {
    expect(strandedHandoff(facts({ execution_status: "blocked" }), NOW)).toBeNull();
    expect(strandedHandoff(facts({ execution_status: "done_with_concerns" }), NOW)).not.toBeNull();
  });

  test("landed, merged by a run, or a merged pull request the handoff names clears it", () => {
    expect(strandedHandoff(facts({ landings: [{ at: NOW - DAY }] }), NOW)).toBeNull();
    expect(strandedHandoff(facts({ prs: [{ number: 5, state: "merged" }] }), NOW)).toBeNull();
  });

  test("a landing from before the handoff clears it only when the handoff names it or came right after it", () => {
    expect(strandedHandoff(facts({ landings: [{ at: NOW - 5 * DAY, sha: "aaaaaaa111" }] }), NOW)).not.toBeNull();
    // Pushed, then handed off.
    expect(strandedHandoff(facts({ landings: [{ at: NOW - 4 * DAY - 60_000 }] }), NOW)).toBeNull();
    const names = { at: NOW - 4 * DAY, text: "Handoff: done\n\nLanded as aaaaaaa1 on main. Branch acme/fix-a" };
    expect(strandedHandoff(facts({ handoff: names, landings: [{ at: NOW - 5 * DAY, sha: "aaaaaaa111" }] }), NOW)).toBeNull();
  });

  test("a pull request naming the task clears it only when it merged with or after the handoff", () => {
    const pr = (merged_at: number) => [{ repository: "a/b", number: 3, state: "merged" as const, merged_at }];
    expect(strandedHandoff(facts({ linked_prs: pr(NOW - 3 * DAY) }), NOW)).toBeNull();
    expect(strandedHandoff(facts({ linked_prs: pr(NOW - 7 * DAY) }), NOW)).not.toBeNull();
  });

  test("an open pull request keeps it stranded and is reported, whether the handoff or the pull request names the other", () => {
    const handoff = { at: NOW - 4 * DAY, text: "Handoff: done" };
    const named = [{ repository: "a/b", number: 7, state: "open" as const }];
    expect(strandedHandoff(facts({ handoff, prs: named }), NOW)?.prs).toEqual(named);
    expect(strandedHandoff(facts({ handoff, linked_prs: named }), NOW)?.prs).toEqual(named);
    expect(strandedHandoff(facts({ handoff, prs: named, linked_prs: named }), NOW)?.prs).toEqual(named);
  });

  test("no code (no guide written with the handoff, files, pull request or branch) is never stranded", () => {
    const handoff = { at: NOW - 4 * DAY, text: "Handoff: done\n\n65,833-contact backtest; page published" };
    expect(strandedHandoff(facts({ handoff }), NOW)).toBeNull();
    expect(strandedHandoff(facts({ handoff, guide_at: NOW - 4 * DAY - 500 }), NOW)).not.toBeNull();
    // An earlier round's guide.
    expect(strandedHandoff(facts({ handoff, guide_at: NOW - 7 * DAY }), NOW)).toBeNull();
    expect(strandedHandoff(facts({ handoff, files_changed: 2 }), NOW)).not.toBeNull();
  });

  test("a task never handed off is not a stranded handoff", () => {
    expect(strandedHandoff(facts({ handoff: null }), NOW)).toBeNull();
  });
});
