import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { statusFailure } from "../sessionStatus";
import { journeyOf } from "../ship/journey";
import { JourneyNowBar } from "../../components/ship/Journey";
import graph from "../ship/__tests__/changeGraph.fixture.json";

// ct-101446: a run waits on a decision someone else holds.
//  1. The viewer, a team admin who is not the holder, must be able to move it
//     along from the session's ship bar (a nudge to the holder, and an answer
//     as admin behind a confirm), not only an "Open card" link. A viewer who is
//     neither holder nor admin gets the link alone.
//  2. The session's sidebar row must not read "Agent stopped" (Error) while
//     its run is live and paused on that approval, even though the agent exited.
//     A stopped agent with no waiting run still reads "Agent stopped".
//
// Interface the fix is held to: JourneyViewer.admin (the store's fact that the
// viewer administers the run's team), and the bar's controls carry
// data-journey-nudge and data-journey-answer-admin.

const NOW = 1_700_000_000_000;
const ME = "u1";
const HOLDER = "u2";
const st = (node_id: string, status: string, t = 1, extra: Record<string, unknown> = {}) => ({ node_id, status, started_at: t, ...extra });
const ROUND = [st("pr", "completed", 1, { visits: 1 }), st("checks", "completed", 2), st("ci", "completed", 2), st("review", "completed", 10), st("joined", "completed", 12)];
const GATE = [...ROUND, st("verdicts", "completed", 13, { visits: 1, result_preview: JSON.stringify({ next: "decide", ci: "green", review: "ship", why: "x" }) }), st("ci_card", "completed", 14), st("decide", "completed", 15), st("decide__decide", "running", 15)];
const RUN = { _id: "run1", status: "paused", user_id: HOLDER, current_node_id: "decide__decide", gate_node_id: "decide__decide", gate_decision_id: "d1", gate_decision_short_id: "dc-1", gate_prompt: "Retire verified_pending gating?", gate_decision_status: "pending", node_statuses: GATE } as any;
const THEIRS = { user_id: HOLDER, holder: { kind: "user" as const, id: HOLDER }, asked_user_ids: [HOLDER] };

const bar = (admin: boolean) => {
  const j = journeyOf(graph as any, RUN, [], { id: ME, decision: THEIRS as any, holder_name: "Samvit Ramadurgam", admin } as any);
  expect(j.now).toMatchObject({ kind: "gate", mine: false });
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(JourneyNowBar, { now: j.now, run: RUN, now_ms: NOW })));
};

describe("a run waiting on someone else's decision", () => {
  test("an admin who does not hold it can nudge the holder or answer as admin from the session", () => {
    const html = bar(true);
    expect(html).toContain("Samvit Ramadurgam");
    expect(html).toContain("data-journey-nudge");
    expect(html).toContain("data-journey-answer-admin");
  });

  test("a viewer who is neither holder nor admin gets only the link to the card", () => {
    const html = bar(false);
    expect(html).toContain("data-journey-open-card");
    expect(html).not.toContain("data-journey-nudge");
    expect(html).not.toContain("data-journey-answer-admin");
  });
});

describe("the sidebar row of a session whose run waits on approval", () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    message_count: 40,
    agent_status: "stopped",
    agent_status_updated_at: NOW - 4 * 86_400_000,
    updated_at: NOW - 4 * 86_400_000,
    started_at: NOW - 5 * 86_400_000,
    is_idle: true,
    is_connected: false,
    thread_state_status: null,
    ...extra,
  }) as any;

  test("does not read Error · Agent stopped while the run is paused on a pending approval", () => {
    expect(statusFailure(row({ workflow_run_id: "run1", workflow_run_status: "paused" }), NOW)).toBeNull();
  });

  test("a stopped agent with no waiting run still reads Agent stopped", () => {
    expect(statusFailure(row(), NOW)).toEqual({ label: "Agent stopped" });
  });
});
