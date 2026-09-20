import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The pill resolves a short id through the store and Convex; this test is
// about the goal rows, so the pill is the id as text.
mock.module("../../EntityIdPill", () => ({ EntityIdPill: ({ shortId }: { shortId: string }) => <span data-pill>{shortId}</span> }));
const { PersonGoals } = await import("./PersonGoals");

const NOW = Date.parse("2026-09-19T15:00:00Z");
const H = 3_600_000;
const person = (over: Record<string, unknown>) => ({ user_id: "u1", name: "Ashot", has_section: true, goals: [], sessions_changed: [], sessions_total: 0, stalled_high: 0, ...over }) as any;

test("each goal shows what is matched to it, what moved and what stalled", () => {
  const html = renderToStaticMarkup(<PersonGoals own roleHandle="chief" now={NOW} person={person({ goals: [
    { text: "Ship org roles", priority: "high", raw: "", refs: [{ kind: "task", short_id: "ct-7", title: "R6", status: "in_progress", updated_at: NOW - 2 * H }], unresolved: [], moved_at: NOW - 2 * H, stalled: false, unmatched: false },
    { text: "Close the round", priority: "high", raw: "", refs: [], unresolved: [], moved_at: null, stalled: true, unmatched: false },
  ] })} />);
  expect(html).toContain('data-person-goals="2"');
  expect(html).toContain("Ship org roles");
  expect(html).toContain("<span data-pill=\"true\">ct-7</span>");
  expect(html).toContain("ct-7 in_progress · moved 2h ago");
  expect(html).toContain('data-goal-stalled="1"');
  expect(html).toContain("nothing matched · stalled");
});

test("a person with no goal section is told where goals go, in their own voice or the reader's", () => {
  const own = renderToStaticMarkup(<PersonGoals own roleHandle="chief" now={NOW} person={person({ has_section: false })} />);
  expect(own).toContain("You report to @chief");
  expect(own).toContain("## Goals: Ashot");
  const other = renderToStaticMarkup(<PersonGoals own={false} roleHandle="chief" now={NOW} person={person({ has_section: false })} />);
  expect(other).toContain("Ashot reports to @chief");
});
