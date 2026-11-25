// The history strip and the pinned-state line drawn as a reader gets them.
// Run: bun test components/priorities/priorityViews.test.tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { HistoryStrip } from "./HistoryStrip";
import { PriorityPinLineView } from "./PriorityPinLine";
import { priorityHref, stripCells, stripLevels } from "../../lib/priorities";

const DAYS = Array.from({ length: 15 }, (_, i) => `2026-11-${String(10 + i).padStart(2, "0")}`);

describe("HistoryStrip", () => {
  test("one cell per day, each titled with its date and count", () => {
    const counts = DAYS.map((_, i) => (i === 11 ? 9 : 0));
    expect(stripCells(DAYS, counts)[11]).toEqual({ day: "2026-11-21", count: 9, title: "Nov 21: 9 typed" });
    const html = renderToStaticMarkup(<HistoryStrip days={DAYS} counts={counts} />);
    expect(html.match(/<i /g)?.length).toBe(15);
    expect(html).toContain('title="Nov 21: 9 typed"');
    expect(html).toContain('title="Nov 10: 0 typed"');
  });

  test("cells shade by count on the activity heat ramp, grey when muted", () => {
    const counts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 40];
    const html = renderToStaticMarkup(<HistoryStrip days={DAYS} counts={counts} />);
    expect(html).toContain("var(--sol-text) 7%"); // an empty day
    expect(html).toContain("var(--sol-green) 100%"); // the busiest
    expect(renderToStaticMarkup(<HistoryStrip days={DAYS} counts={counts} muted />)).toContain("var(--sol-text-muted) 100%");
  });

  test("a priority with no typing draws empty cells; shared levels compare strips", () => {
    expect(renderToStaticMarkup(<HistoryStrip days={DAYS} counts={undefined} />)).not.toContain("--sol-green");
    const levels = stripLevels([[0, 40], [1, 1]]);
    const quiet = renderToStaticMarkup(<HistoryStrip days={DAYS.slice(0, 2)} counts={[1, 1]} levels={levels} />);
    expect(quiet).not.toContain("var(--sol-green) 100%");
  });
});

const pin = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("PriorityPinLineView", () => {
  test("names the priority, its critical path and this session's step, and opens it", () => {
    const html = pin(
      <PriorityPinLineView line={{ short_id: "pri-4", title: "Trusted evals", rank: 1, critical_done: 3, critical_total: 6, step_title: "Grader faults under 10%" }} />,
    );
    expect(html).toContain(`href="${priorityHref("pri-4")}"`);
    expect(priorityHref("pri-4")).toBe("/priorities?open=pri-4");
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe("↳#1 Trusted evals · 3/6 · Grader faults under 10%");
  });

  test("an unranked priority with no step says only what it knows", () => {
    const text = pin(<PriorityPinLineView line={{ short_id: "pri-4", title: "Trusted evals", rank: null, critical_done: 0, critical_total: 2 }} />).replace(/<[^>]+>/g, "");
    expect(text).toBe("↳Trusted evals · 0/2");
  });

  test("renders nothing when the session maps to no priority", () => {
    expect(pin(<PriorityPinLineView line={null} />)).toBe("");
  });
});
