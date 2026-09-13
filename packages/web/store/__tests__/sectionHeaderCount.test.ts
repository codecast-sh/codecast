import { describe, expect, it } from "bun:test";
import { sectionHeaderCount, type InboxSession } from "../inboxStore";

// The header number must describe the section under it. `placed.counts` counts
// every row PLACED in a bucket — flat cards plus members nested under a
// same-bucket lead — and that is honest only while the nested rows render.
// Prod, 2026-09-10: with the subagent toggle off the panel showed
// "NEEDS INPUT (121)" above 33 cards, while the sidebar badge (flat cards)
// said 34. Nothing on screen could reach the other 88.

const row = (id: string): InboxSession => ({ _id: id } as InboxSession);
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`s${i}`));

describe("sectionHeaderCount", () => {
  it("counts the nested members while subagents are shown", () => {
    const cards = rows(33);
    expect(sectionHeaderCount(cards, cards, 121, true)).toBe(121);
  });

  it("counts only the cards on screen while subagents are hidden", () => {
    const cards = rows(33);
    expect(sectionHeaderCount(cards, cards, 121, false)).toBe(33);
  });

  it("defers to the shown cards when a chip filter narrowed the section", () => {
    expect(sectionHeaderCount(rows(4), rows(33), 121, true)).toBeUndefined();
    expect(sectionHeaderCount(rows(4), rows(33), 121, false)).toBeUndefined();
  });

  it("leaves an unnarrowing filter's full count in force", () => {
    const cards = rows(33);
    expect(sectionHeaderCount([...cards], cards, 121, true)).toBe(121);
  });
});
