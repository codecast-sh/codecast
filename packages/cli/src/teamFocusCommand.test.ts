import { describe, expect, test } from "bun:test";
import { formatFocus, runTeamFocus } from "./teamFocusCommand";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const result = {
  assignments: [
    { user_id: "u1", name: "Sam", takes_decisions: true, projects: [{ id: "p1", title: "Deal flow" }, { id: "p2", title: "Intros" }] },
    { user_id: "u2", name: "Jason", takes_decisions: false, projects: [{ id: "p3", title: "Desk" }] },
    { user_id: "u3", name: "Dev", takes_decisions: true, projects: [] },
  ],
  unplaced: ["calling"],
  text: "Sam: Deal flow, Intros; Jason (not taking decisions): Desk",
};

describe("cast team focus", () => {
  test("prints each member's areas and what matched nothing", () => {
    const out = strip(formatFocus({ ...result, applied: 2 }, { team: "Acme" }));
    expect(out).toContain("Areas in Acme, applied");
    expect(out).toMatch(/Sam\s+Deal flow, Intros/);
    expect(out).toMatch(/Jason\s+Desk  \(takes no decisions\)/);
    expect(out).toMatch(/Dev\s+no areas/);
    expect(out).toContain("Matched no project: calling");
  });

  test("a dry run says nothing changed; no words shows the areas as they stand", () => {
    expect(strip(formatFocus(result, { team: "Acme", dryRun: true }))).toContain("Nothing changed");
    expect(strip(formatFocus({ ...result, current: true }, { team: "Acme" }))).toContain('Change them: cast team focus "');
  });

  test("posts the words and the team to /cli/team/focus", async () => {
    const posts: any[] = [];
    const log = console.log;
    console.log = () => {};
    try {
      await runTeamFocus(async (route, body) => { posts.push([route, body]); return result; }, { kind: "team", teamId: "t1" }, () => "Acme", "Sam: deals", true);
    } finally {
      console.log = log;
    }
    expect(posts).toEqual([["/cli/team/focus", { team_id: "t1", words: "Sam: deals", dry_run: true }]]);
  });
});
