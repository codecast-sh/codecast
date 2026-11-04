import { expect, test } from "bun:test";
import { buildWeekCard, weekBounds } from "@codecast/shared/contracts/weeklyCard";
import { weekCardLedger } from "./weekCardLedger";

const now = Date.UTC(2026, 10, 3, 18);
const bounds = weekBounds(now, "UTC", "last");
const stats = buildWeekCard({
  bounds, tz: "UTC", now,
  sessions: [{ started_at: bounds.start + 3_600_000, updated_at: bounds.start + 7_200_000, agent_type: "codex", project: "app" }],
  devices: [],
  tokenHours: [[bounds.start, 10]],
});
const rows = (l: ReturnType<typeof weekCardLedger>) => Object.fromEntries(l.rows.map((r) => [r.k, r.list ?? []]));

test("the review names what goes public and what never does", () => {
  const off = rows(weekCardLedger(stats, {}));
  expect(off["Never shows"]).toEqual(expect.arrayContaining(["Project names", "Tokens", "Titles, prompts, transcripts"]));
  expect(off["Shows"].join(" ")).not.toContain("Projects");
  const on = rows(weekCardLedger(stats, { show_projects: true, show_tokens: true }));
  expect(on["Shows"]).toEqual(expect.arrayContaining(["Projects: app", "Token total"]));
  expect(on["Never shows"]).not.toContain("Project names");
});
