import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangesFooter } from "../ChangesFooter";
import { DAY, edition } from "./fixtures";

// The footer says where the notes came from and nothing it cannot back: no
// sources the page never reads, and no counts or live claims for a day where
// nothing landed.

const stats = { commits: 12, stories: 4, releases: 0, people: 2, sessions: 0, private_sessions: 0 };
const render = (over: Partial<Parameters<typeof ChangesFooter>[0]> = {}) =>
  renderToStaticMarkup(<ChangesFooter stats={stats} edition={edition({ status: "written", headline: "x" })} hasSignals={false} date={DAY} today={DAY} {...over} />);

describe("the footer", () => {
  test("names only the sources reasons come from: commit messages and PRs, never plans", () => {
    const html = render();
    expect(html).toContain("Reasons come from commit messages and PRs.");
    expect(html).not.toMatch(/plan/i);
  });

  test("a day with commits and no deploy marker says live status is not shown", () => {
    expect(render()).toContain("No deploy marker for this repository, so live status is not shown.");
    expect(render()).toContain("from 12 commits");
  });

  test("a quiet day writes no provenance and no live line", () => {
    for (const html of [render({ stats: null }), render({ stats: { ...stats, commits: 0, stories: 0, people: 0 } })]) {
      expect(html).not.toContain("Written");
      expect(html).not.toContain("Notes written");
      expect(html).not.toContain("deploy marker");
    }
  });
});
