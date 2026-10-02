import { describe, expect, test } from "bun:test";
import { cleanSubject, clip, DEK_MAX, sliceDek, statsHeadline, storyDek, storyHeadline } from "./headline";

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
