import { describe, expect, it } from "bun:test";
import type { MovedEvent, SurfaceOverview } from "../../contract";
import { evalsPaths } from "../paths";
import { WALL_AXIS_LABEL_GAP, attributeHref, movedLine, newestWorsePair, rowHref, wallAxisTicks, wallOrder, wallSpend, wallWindowDays, wallWindowFrom } from "./wallModel";
import { noiseFlipWords, noiseFlipsShort } from "./verdictModel";

const DAY = 24 * 60 * 60 * 1000;

/** A wall row with only what the order, the pair and the window read: its route, its strip and its latest verdict. */
function row(id: string, route: string, latest: { kind: "worse" | "same" | "better"; at: string; baseline?: Array<[string, string]> } | null): SurfaceOverview {
  const base = latest?.baseline ?? [];
  const strip = [...base, ...(latest ? ([[`${id}-latest`, latest.at]] as Array<[string, string]>) : [])].map(([batch, batchAt]) => ({ batch, batchAt }));
  return {
    id,
    route,
    strip,
    latest: latest && { batch: `${id}-latest`, set: { batchAt: latest.at }, separation: { kind: latest.kind }, baseline: { kind: "previous", batches: base.map(([b]) => b) } },
  } as unknown as SurfaceOverview;
}

describe("the wall's order", () => {
  const surfaces = [
    row("triage", "agent", { kind: "same", at: "2026-10-04T00:00:00Z" }),
    row("settle", "call", { kind: "worse", at: "2026-10-03T00:00:00Z", baseline: [["s-a", "2026-10-01T00:00:00Z"], ["s-b", "2026-10-02T00:00:00Z"]] }),
    row("title", "call", { kind: "better", at: "2026-10-04T00:00:00Z" }),
    row("insight", "call", { kind: "worse", at: "2026-10-04T00:00:00Z", baseline: [["i-a", "2026-10-03T00:00:00Z"]] }),
    row("quiet", "agent", null),
  ];

  it("puts rows that separated worse first, newest first, then call surfaces, then agent surfaces, each in the api's order", () => {
    expect(wallOrder(surfaces).map((s) => s.id)).toEqual(["insight", "settle", "title", "triage", "quiet"]);
  });

  it("names the newest worse pair, the red batch and the newest batch of its baseline, and opens a worse row on it", () => {
    const { href } = evalsPaths("/admin/evals");
    expect(newestWorsePair(surfaces)).toEqual({ surface: "insight", good: "i-a", bad: "insight-latest" });
    expect(rowHref(href, surfaces[1]!)).toBe(href.surface("settle", { batch: "settle-latest", compare: "s-b" }));
    expect(rowHref(href, surfaces[2]!)).toBe("/admin/evals/s/title");
    expect(attributeHref(href, surfaces, "title")).toBe(href.bisectNew({ surface: "insight", good: "i-a", bad: "insight-latest" }));
    // Nothing worse: b opens the launcher for the selected surface, which picks its own red batch.
    const calm = surfaces.filter((s) => s.latest?.separation.kind !== "worse");
    expect(newestWorsePair(calm)).toBeNull();
    expect(attributeHref(href, calm, "title")).toBe(href.bisectNew({ surface: "title" }));
  });
});

describe("the time window", () => {
  const now = Date.parse("2026-10-04T06:00:00Z");
  const at = (iso: string) => ({ surfaces: [row("settle", "call", { kind: "same", at: iso })], spendByDay: [] });

  it("starts just before the oldest batch, so a short history fills the strip", () => {
    const oldest = Date.parse("2026-09-20T12:00:00Z");
    expect(wallWindowFrom(at("2026-09-20T12:00:00Z"), now)).toBe(oldest - (now - oldest) * 0.03);
  });

  it("is never narrower than 2 days nor wider than 30, and falls back to the spend days when no batch places it", () => {
    expect(wallWindowFrom(at("2026-10-03T23:00:00Z"), now)).toBe(now - 2 * DAY);
    expect(wallWindowFrom(at("2026-07-01T12:00:00Z"), now)).toBe(now - 30 * DAY);
    expect(wallWindowFrom({ surfaces: [], spendByDay: [] }, now)).toBe(now - 30 * DAY);
    const spendOnly = wallWindowFrom({ surfaces: [], spendByDay: [{ day: "2026-09-24", usd: 1, judgeUsd: 0 }] }, now);
    expect(spendOnly).toBeLessThan(Date.parse("2026-09-24T00:00:00Z"));
    expect(spendOnly).toBeGreaterThan(now - 30 * DAY);
  });

  it("never sets two date labels closer than a label is wide, down to a split pane's strip", () => {
    const from = now - 6 * DAY;
    for (const width of [120, 180, 240, 320, 480, 760]) {
      const ticks = wallAxisTicks(from, now, width);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.x - ticks[i - 1]!.x).toBeGreaterThanOrEqual(WALL_AXIS_LABEL_GAP);
      expect(ticks.every((t) => t.x >= 0 && t.x <= width)).toBe(true);
    }
    // A wide strip still labels every day.
    expect(wallAxisTicks(from, now, 760).length).toBeGreaterThanOrEqual(6);
  });
});

describe("wallSpend", () => {
  const to = Date.UTC(2026, 9, 5, 12);
  const days = [
    { day: "2026-09-20", usd: 500, judgeUsd: 10 },
    { day: "2026-10-02", usd: 600, judgeUsd: 20 },
    { day: "2026-10-03", usd: 400, judgeUsd: 30 },
    { day: "2026-10-05", usd: 200, judgeUsd: 18 },
  ];

  it("reads one window for the header and the spend row: the days the strip draws, over the window's length", () => {
    const from = to - 3 * DAY;
    const s = wallSpend(days, from, to);
    expect(s.days).toBe(3);
    // Oct 2 began before the window but reaches into it, as the strip draws it; Sep 20 does not.
    expect(s.usd).toBe(620 + 430 + 218);
    expect(wallWindowDays(from, to)).toBe(s.days);
  });

  it("widens with the window", () => {
    expect(wallSpend(days, to - 30 * DAY, to)).toEqual({ usd: 510 + 620 + 430 + 218, days: 30 });
  });
});

describe("noise flip words", () => {
  const flip = { freezeId: "f", name: "jx7btyt:100", visibility: "private" as const, direction: "broke" as const, before: ["a"], after: ["b"] };

  it("names why a flip is not counted, short on the row and long in its title", () => {
    const noisy = { ...flip, history: { flips: 9, batches: 22 }, samePrompt: true };
    expect(noiseFlipsShort([noisy])).toBe("1 flip on noise: flaps 9 of 22, same prompt");
    expect(noiseFlipWords(noisy)).toBe("jx7btyt:100 broke, flaps: 9 of 22 batches, same prompt on both sides");
    expect(noiseFlipsShort([{ ...flip, history: { flips: 1, batches: 22 }, samePrompt: true }])).toBe("1 flip on noise: same prompt");
    expect(noiseFlipsShort([noisy, noisy])).toBe("2 flips on noise");
  });
});

describe("movedLine", () => {
  const { href } = evalsPaths("/admin/evals");
  const at = "2026-10-05T07:55:00.000Z";

  it("sends a shared kind to its page under the host's base", () => {
    const e: MovedEvent = { at, surface: "settle", kind: "flips", batch: "nightly-1", broke: 2, fixed: 1 };
    expect(movedLine(href, e)).toEqual({ href: href.surface("settle", { batch: "nightly-1" }), text: "settle: 2 freezes broke, 1 fixed" });
    // A product names its own case.
    expect(movedLine(href, { ...e, noise: 1 }, undefined, { one: "scenario", many: "scenarios" }).text).toBe("settle: 2 scenarios broke, 1 fixed, 1 flip on flapping scenarios or an unchanged prompt");
    expect(movedLine(href, { at, surface: "settle", kind: "bisect", id: "b1", outcome: null }).href).toBe("/admin/evals/bisect/b1");
  });

  it("hands a host's own kind to its drawer and keeps the line it made, extra fields and all", () => {
    type Own = { at: string; kind: "sim-failure"; run: string };
    const own = (e: Own) => ({ href: `/sim/${e.run}`, text: "sim broke", mark: "!" });
    const event: Own = { at, kind: "sim-failure", run: "r1" };
    const line = movedLine(href, event, own);
    const mark: string = "mark" in line ? line.mark : "";
    expect(line).toEqual({ href: "/sim/r1", text: "sim broke", mark: "!" });
    expect(mark).toBe("!");
  });

  it("draws a kind no one knows as a plain line home", () => {
    const stray = { at, surface: null, kind: "sim-failure" } as unknown as MovedEvent;
    expect(movedLine(href, stray)).toEqual({ href: "/admin/evals", text: "The evals moved" });
  });
});
