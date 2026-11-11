import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxSession } from "../../store/inboxStore";
import { CardWorkersLine } from "./SessionCardParts";

// The quiet line under a card whose agent spawned workers: the count in
// secondary ink, and only the "needs you" part in the accent.

const w = (id: string) => ({ _id: id } as InboxSession);
const html = (count: number, needsYou: InboxSession[]) =>
  renderToStaticMarkup(<CardWorkersLine count={count} needsYou={needsYou} onOpen={() => {}} />);

describe("CardWorkersLine", () => {
  test("silent with no workers", () => {
    expect(html(0, [])).toBe("");
  });

  test("names the folded workers in secondary ink, no accent when none wait", () => {
    const out = html(3, []);
    expect(out).toContain("3 workers");
    expect(out).toContain("text-sol-text-muted");
    expect(out).toContain("text-[12px]");
    expect(out).not.toContain("text-sol-cyan");
    expect(out).not.toContain("need");
  });

  test("names the workers waiting on the person in the accent", () => {
    const out = html(3, [w("a")]);
    expect(out).toContain("3 workers");
    expect(out).toContain("1 needs you");
    expect(out).toContain('data-sv-workers-needs-you="1"');
    expect(out).toContain("text-sol-cyan");
    expect(html(1, [w("a"), w("b")])).toContain("2 need you");
    expect(html(1, [])).toContain("1 worker<");
  });
});
