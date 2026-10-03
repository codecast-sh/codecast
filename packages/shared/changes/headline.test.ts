import { describe, expect, test } from "bun:test";
import { cleanSubject, clip, DEK_MAX, fitProse, HEADLINE_MAX, leadSentences, sliceDek, statsHeadline, storyDek, storyHeadline } from "./headline";

describe("cleanSubject", () => {
  test("strips the conventional prefix and capitalizes", () => {
    expect(cleanSubject("feat(web): line pages, share pages, org staffing and app updates")).toBe("Line pages, share pages, org staffing and app updates");
    expect(cleanSubject("fix(cli): match a hook entry by the file it names, not its spelling.")).toBe("Match a hook entry by the file it names, not its spelling");
    expect(cleanSubject("Added zoom support")).toBe("Added zoom support");
    expect(cleanSubject("chore: npm audit fixes")).toBe("npm audit fixes");
    expect(cleanSubject("fix(cli): cast check reuses the watcher")).toBe("cast check reuses the watcher");
  });

  test("keeps the revert and short ids", () => {
    expect(cleanSubject('Revert "feat(web): mention menu"')).toBe('Revert "Mention menu"');
    expect(cleanSubject("revert: fix(cli): x")).toBe('Revert "X"');
    expect(cleanSubject("fix: jx7c6zk loses #412 on reload")).toBe("jx7c6zk loses #412 on reload");
    expect(cleanSubject("chore: bun.lock refresh")).toBe("bun.lock refresh");
  });
});

describe("story text", () => {
  const units = [
    { sha: "a", subject: "fix(cli): fleet migration finds the agent", timestamp: 1, lines: 96 },
    { sha: "b", subject: "feat(cli): slot priority for helpers", timestamp: 2, lines: 412 },
    { sha: "c", subject: "test(cli): fleet fixture", timestamp: 3, lines: 40 },
  ];

  test("the headline is the largest commit's subject, the dek the others in order", () => {
    expect(storyHeadline(units)).toBe("Slot priority for helpers");
    expect(storyDek(units)).toBe("Fleet migration finds the agent; Fleet fixture");
  });

  test("a single commit's dek is its body's first paragraph", () => {
    expect(storyDek([units[0]], "The pane shell owns the agent.\n\nMore.")).toBe("The pane shell owns the agent.");
    expect(storyDek([units[0]])).toBe("");
  });

  test("clips at a word boundary", () => {
    const long = clip("word ".repeat(60), DEK_MAX);
    expect(long.length).toBeLessThanOrEqual(DEK_MAX);
    expect(long.endsWith("word…")).toBe(true);
  });

  test("facts for slices and the edition", () => {
    expect(sliceDek({ scripts: 3, github: 2, root: 1 })).toBe("6 files across scripts, github, root");
    expect(statsHeadline({ commits: 16, stories: 9, releases: 3 })).toBe("16 commits, 3 releases, 9 stories");
    expect(statsHeadline({ commits: 1, stories: 1, releases: 0 })).toBe("1 commit, 1 story");
  });
});

describe("fitProse", () => {
  // The shapes of three lines the page cut mid-clause, reworded: the repository is public.
  const edition = "Outreach stops emailing people never pitched, and the tip engine now scores job seekers with five signals instead of two";
  const story = "The tip engine ranks job seekers with five signals, weighting recent replies over profile completeness while keeping the old score as a tiebreak";

  test("text within the hard limit stays whole, even past the target", () => {
    expect(fitProse("Short and whole", 110, 150)).toBe("Short and whole");
    expect(edition.length).toBeGreaterThan(110);
    expect(edition.length).toBeLessThanOrEqual(150);
    expect(fitProse(edition, 110, 150)).toBe(edition);
  });

  test("past the hard limit it ends on a clause, with no ellipsis and the meaning intact", () => {
    const long = `${edition}, with a migration that backfills the contact effort column for every past send`;
    const out = fitProse(long, 110, 150);
    expect(out).toBe(edition);
    expect(out).not.toContain("…");
    // The cut that inverted the meaning: "stops emailing people never…".
    expect(out).toContain("people never pitched");
  });

  test("a story headline is cut at its last whole clause", () => {
    expect(story.length).toBeGreaterThan(120);
    const out = fitProse(story, HEADLINE_MAX, 120);
    expect(out).toBe("The tip engine ranks job seekers with five signals, weighting recent replies over profile completeness");
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("a boundary that would keep too little is not used; text with none falls back to clip", () => {
    const early = `Fix, ${"x".repeat(200)}`;
    expect(fitProse(early, 90, 120)).toBe(clip(early, 90));
    expect(fitProse("y".repeat(200), 90, 120).endsWith("…")).toBe(true);
  });

  test("whitespace folds the way clip folds it", () => {
    expect(fitProse("  two\n  lines ", 90, 120)).toBe("two lines");
  });
});

describe("leadSentences", () => {
  test("keeps whole sentences up to the word budget and hands back the rest", () => {
    const text = "One two three. Four five six seven. Eight nine ten.";
    expect(leadSentences(text, 7)).toEqual({ lead: "One two three. Four five six seven.", rest: "Eight nine ten." });
    expect(leadSentences(text, 60)).toEqual({ lead: text, rest: "" });
  });

  test("a first sentence over the budget still leads whole", () => {
    expect(leadSentences("A very long first sentence here. Short.", 3)).toEqual({ lead: "A very long first sentence here.", rest: "Short." });
  });

  test("a version or a file name never ends a sentence", () => {
    expect(leadSentences("Shipped cli 1.1.163 and foo.ts today. Then more.", 6).lead).toBe("Shipped cli 1.1.163 and foo.ts today.");
  });
});
