import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareMenu } from "../ShareMenu";
import { shareMenuActions, startOfDay } from "../../../lib/team/shareImpact";

// The menu is the moment of choice. Every option must carry who sees it, at
// what level, and the number one click exposes, before the click.

const NOW = Date.now();
const impact = { repos: 1, sessions: 241, first: NOW - 80 * 86_400_000, last: NOW, older: 0, olderThanDay: 237, hidden: 3, manuallyShared: 0, truncated: false, exact: true };
const teams = [
  { _id: "t_union" as any, name: "Union", visibility: "full", member_count: 23 },
  { _id: "t_footage" as any, name: "Footage", visibility: "hidden", member_count: 4 },
];

function render(props: Partial<Parameters<typeof ShareMenu>[0]> = {}) {
  return renderToStaticMarkup(
    <ShareMenu
      name="codecast"
      impact={impact}
      counting={false}
      teams={teams}
      current={null}
      onShare={() => {}}
      onStop={() => {}}
      onLock={() => {}}
      onReview={() => {}}
      {...props}
    />,
  );
}

describe("ShareMenu", () => {
  test("the trigger names the current rule", () => {
    expect(render()).toContain("Only me");
    expect(render({ current: { teamId: "t_union" as any, teamName: "Union", shareSince: null } })).toContain("Union");
    expect(render({ current: { teamId: "t_union" as any, teamName: "Union", shareSince: null, inherited: true } })).toContain("(repo)");
  });
  test("a lock reads as never shared, on its own checkout or through the repository", () => {
    expect(render({ current: { locked: true } })).toContain("Never shared");
    expect(render({ current: { locked: true, inherited: true } })).toContain("(repo)");
    expect(render({ current: { locked: true } })).not.toContain("Only me");
  });
  test("the menu stands without a team, so a lock is always reachable", () => {
    expect(render({ teams: [] })).toContain("Only me");
  });
  // Radix renders the menu content only while open, so the option wording is
  // pinned through the pure helper the menu reads; the open menu is checked
  // in the browser.
  test("from today and everything carry their numbers", () => {
    const a = shareMenuActions(impact, NOW);
    expect(a.fromToday.detail).toBe("New sessions only. The 237 sessions you already have stay private.");
    expect(a.everything.label).toBe("Share all 241 sessions");
    expect(a.everything.detail).toContain("3 sessions you hid by hand stay hidden.");
    expect(startOfDay(NOW) <= NOW).toBe(true);
  });
});
