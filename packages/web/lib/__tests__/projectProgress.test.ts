// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { buildBurndown, buildProgressSeries } from "../projectProgress";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const ago = (days) => NOW - days * DAY;

const series = (tasks, now = NOW) => buildProgressSeries(tasks, now);
const last = (s) => s.points[s.points.length - 1];

describe("buildProgressSeries", () => {
  it("returns an empty series and zero totals for no tasks", () => {
    const s = series([]);
    expect(s.points).toEqual([]);
    expect([s.scope, s.started, s.done]).toEqual([0, 0, 0]);
  });

  it("counts a task into scope from the day it was created", () => {
    const s = series([{ status: "open", created_at: ago(3) }]);
    expect(s.points[0].scope).toBe(1);
    expect(last(s).scope).toBe(1);
    expect(last(s).done).toBe(0);
  });

  it("leaves dropped work out of scope entirely", () => {
    const s = series([
      { status: "open", created_at: ago(5) },
      { status: "dropped", created_at: ago(5), closed_at: ago(1) },
    ]);
    expect(s.scope).toBe(1);
    expect(last(s).scope).toBe(1);
  });

  it("counts closed work as done only when it actually finished", () => {
    const s = series([
      { status: "done", created_at: ago(5), closed_at: ago(2) },
      { status: "dropped", created_at: ago(5), closed_at: ago(2) },
    ]);
    expect(s.done).toBe(1);
    expect(last(s).done).toBe(1);
  });

  it("shows work landing over time rather than all at the end", () => {
    const s = series([
      { status: "done", created_at: ago(10), closed_at: ago(8) },
      { status: "done", created_at: ago(10), closed_at: ago(4) },
      { status: "open", created_at: ago(10) },
    ]);
    // The LAST point at or before that day — the first point is the project's birth.
    const early = s.points.filter((p) => p.t <= ago(6)).pop();
    expect(early.done).toBe(1);
    expect(last(s).done).toBe(2);
    expect(last(s).scope).toBe(3);
  });

  it("never draws done above started, even when started_at is missing", () => {
    // A task that closed must have been started; without the fallback the done
    // line would cross above the started line, which would be drawing a lie.
    const s = series([{ status: "done", created_at: ago(5), closed_at: ago(2) }]);
    for (const p of s.points) expect(p.done).toBeLessThanOrEqual(p.started);
    expect(last(s).started).toBe(1);
  });

  it("keeps every series monotone — cumulative counts never go down", () => {
    const s = series([
      { status: "done", created_at: ago(9), started_at: ago(8), closed_at: ago(7) },
      { status: "in_progress", created_at: ago(6), started_at: ago(3) },
      { status: "open", created_at: ago(2) },
    ]);
    for (let i = 1; i < s.points.length; i++) {
      expect(s.points[i].scope).toBeGreaterThanOrEqual(s.points[i - 1].scope);
      expect(s.points[i].started).toBeGreaterThanOrEqual(s.points[i - 1].started);
      expect(s.points[i].done).toBeGreaterThanOrEqual(s.points[i - 1].done);
    }
  });

  it("shows scope growing when work is discovered later", () => {
    const s = series([
      { status: "open", created_at: ago(10) },
      { status: "open", created_at: ago(2) },
    ]);
    expect(s.points[0].scope).toBe(1);
    expect(last(s).scope).toBe(2);
  });

  it("ends at now, so the last point matches the headline totals", () => {
    const s = series([
      { status: "done", created_at: ago(4), started_at: ago(3), closed_at: ago(1) },
      { status: "open", created_at: ago(4) },
    ]);
    expect(last(s).t).toBe(NOW);
    expect(last(s).scope).toBe(s.scope);
    expect(last(s).started).toBe(s.started);
    expect(last(s).done).toBe(s.done);
  });

  it("widens its buckets instead of drawing a point per day forever", () => {
    const s = series([{ status: "open", created_at: ago(2000) }]);
    expect(s.points.length).toBeLessThanOrEqual(61);
    expect(last(s).t).toBe(NOW);
  });

  it("still produces a series for a project created moments ago", () => {
    const s = series([{ status: "open", created_at: NOW - 1000 }]);
    expect(s.points.length).toBeGreaterThan(0);
    expect(last(s).scope).toBe(1);
  });

  it("ignores rows with no creation time rather than placing them at zero", () => {
    const s = series([{ status: "open" }, { status: "open", created_at: ago(1) }]);
    expect(s.scope).toBe(1);
  });
});

describe("buildBurndown", () => {
  const burndown = (tasks, deadline, now = NOW) =>
    buildBurndown(buildProgressSeries(tasks, now), deadline, now);

  // Ten tasks, one finished per day for the last five days: a steady pace of
  // one a day with five left.
  const steady = () => [
    ...Array.from({ length: 5 }, (_, i) => ({
      status: "done",
      created_at: ago(10),
      closed_at: ago(5 - i),
    })),
    ...Array.from({ length: 5 }, () => ({ status: "open", created_at: ago(10) })),
  ];

  it("derives remaining as scope minus done at every point", () => {
    const b = burndown(steady(), undefined);
    expect(b.remaining).toBe(5);
    expect(b.points[0].remaining).toBe(10);
    expect(b.points[b.points.length - 1].remaining).toBe(5);
  });

  it("projects the landing from the recent pace", () => {
    const b = burndown(steady(), undefined);
    expect(b.verdict).toBe("no_deadline");
    // 5 done over the project's 10-day life is 0.5/day; 5 remaining lands
    // about 10 days out. Bucketing makes the pace approximate, so allow a band.
    const days = (b.projectedEnd - NOW) / DAY;
    expect(days).toBeGreaterThan(7);
    expect(days).toBeLessThan(14);
  });

  it("calls a comfortable deadline hit and a tight one miss", () => {
    expect(burndown(steady(), NOW + 30 * DAY).verdict).toBe("hit");
    expect(burndown(steady(), NOW + 1 * DAY).verdict).toBe("miss");
  });

  it("declares done when nothing remains", () => {
    const b = burndown(
      [{ status: "done", created_at: ago(5), closed_at: ago(1) }],
      NOW + 5 * DAY,
    );
    expect(b.verdict).toBe("done");
    expect(b.remaining).toBe(0);
  });

  it("refuses to project when nothing finished recently", () => {
    const b = burndown(
      [
        { status: "done", created_at: ago(100), closed_at: ago(60) },
        { status: "open", created_at: ago(100) },
      ],
      NOW + 5 * DAY,
    );
    expect(b.verdict).toBe("no_velocity");
    expect(b.projectedEnd).toBeUndefined();
  });

  it("measures pace over a young project's whole life", () => {
    const b = burndown(
      [
        { status: "done", created_at: ago(2), closed_at: ago(1) },
        { status: "open", created_at: ago(2) },
      ],
      NOW + 30 * DAY,
    );
    expect(b.velocity).toBeGreaterThan(0);
    expect(b.verdict).toBe("hit");
  });

  it("returns an empty shape for a project with no tasks", () => {
    const b = burndown([], NOW + 5 * DAY);
    expect(b.points).toEqual([]);
    expect(b.remaining).toBe(0);
    expect(b.verdict).toBe("no_velocity");
  });
});
