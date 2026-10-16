import { describe, expect, test } from "bun:test";
import { ageWords, isHeadSuggestion, pieceAge, splitSuggestions } from "./suggestionSetModel";

const DAY = 86_400_000;
const HEAD = "role_head";
const ws = { kind: "team" as const, id: "team_a" };
const row = (id: string, o: Record<string, unknown> = {}) => ({
  _id: id, status: "open" as const, team_id: "team_a", mode: "review" as const, created_at: 0,
  author: { kind: "role" as const, id: HEAD }, ...o,
});

describe("the Head of People's suggestions as one set", () => {
  test("its open proposals form the set oldest first; a replaced one and another author's stand apart", () => {
    const rows = [
      row("b", { created_at: 3 * DAY }),
      row("a", { created_at: 1 * DAY }),
      row("old", { created_at: 0, superseded_by: { id: "b", short_id: "op-2", status: "open", created_at: 3 * DAY } }),
      row("hire", { mode: "request", author: { kind: "role", id: "role_growth" }, created_at: 2 * DAY }),
      row("done", { status: "resolved" }),
      row("elsewhere", { team_id: "team_b" }),
    ];
    const s = splitSuggestions(rows as any, ws, HEAD);
    expect(s.set.map((r) => r._id)).toEqual(["a", "b"]);
    expect(s.replaced.map((r) => r._id)).toEqual(["old"]);
    expect(s.others.map((r) => r._id)).toEqual(["hire"]);
  });

  test("a proposal replaced by one that is no longer open is still current", () => {
    const rows = [row("old", { superseded_by: { id: "gone", short_id: "op-9", status: "withdrawn", created_at: 1 } })];
    expect(splitSuggestions(rows as any, ws, HEAD).set.map((r) => r._id)).toEqual(["old"]);
  });

  test("a review run's proposal is the Head of People's whoever ran it; a role's request is only when it is the head's", () => {
    expect(isHeadSuggestion({ mode: "review", author: { kind: "session", id: "s1" } } as any, HEAD)).toBe(true);
    expect(isHeadSuggestion({ mode: "request", author: { kind: "role", id: HEAD } } as any, HEAD)).toBe(true);
    expect(isHeadSuggestion({ mode: "request", author: { kind: "user", id: "u" } } as any, HEAD)).toBe(false);
  });

  test("a piece is as old as its last revise, else its proposal; ages read at a glance", () => {
    expect(pieceAge(100, [{ revision: { at: 500 } } as any, {} as any])).toBe(500);
    expect(pieceAge(100, [])).toBe(100);
    expect(ageWords(0, DAY / 2)).toBe("today");
    expect(ageWords(0, 3 * DAY)).toBe("3d");
    expect(ageWords(0, 15 * DAY)).toBe("2w");
  });
});
