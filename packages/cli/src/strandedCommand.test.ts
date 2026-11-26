import { describe, expect, test } from "bun:test";
import { strandedLines } from "./strandedCommand.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

describe("cast task stranded output", () => {
  test("ends with a count and the commands that settle a row, naming none of them", () => {
    const rows = [
      { short_id: "ct-1", title: "Fix a", assignee: null, handed_off_at: NOW - 5 * DAY, handed_off_by: "jx1", branches: ["acme/fix-a"], prs: [] },
      { short_id: "ct-2", title: "Fix b", assignee: "someone", handed_off_at: NOW - 4 * DAY, handed_off_by: null, branches: [], prs: [{ repository: "acme/app", number: 7, state: "open" as const }] },
    ];
    const lines = plain(strandedLines({ rows, capped_at: null }, 3, NOW));
    expect(lines.slice(-2)).toEqual([
      "  2 stranded handoffs, handed off over 3d ago with nothing landed.",
      "  Ship one: cast flow run change --task <id> · already on main: cast task done <id> · abandoned: cast task drop <id>",
    ]);
    expect(lines[3]).toContain("acme/app#7 open");
  });

  test("an empty list says so and offers nothing to run", () => {
    expect(plain(strandedLines({ rows: [], capped_at: null }, 3, NOW))).toEqual(["No finished handoff in review is older than 3d without landing."]);
  });

  test("a read that hit the cap says only the least recently touched were judged, with rows or without", () => {
    const row = { short_id: "ct-1", title: "Fix a", assignee: null, handed_off_at: NOW - 5 * DAY, handed_off_by: null, branches: ["acme/fix-a"], prs: [] };
    const notice = "  Read only the 1000 least recently touched of more than 1000 tasks in review.";
    expect(plain(strandedLines({ rows: [row], capped_at: 1000 }, 3, NOW)).at(-1)).toBe(notice);
    expect(plain(strandedLines({ rows: [], capped_at: 1000 }, 3, NOW))).toEqual(["No finished handoff in review is older than 3d without landing.", notice]);
  });
});
