// A row in a list holds still. One pulsing or pinging dot per running or
// pending session made the browser re-layer the whole page on every frame,
// keystrokes included, and the cost grew with the number of agents running.
// Rows show their state with a solid dot; only a single indicator (the open
// conversation's status, a section header) may move.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardStatusSignals } from "../inbox/SessionCardParts";
import { LivePulseDot } from "../SessionActivityLine";

const MOTION = /animate-(ping|pulse)/;

const row = (over: Record<string, unknown> = {}) => ({
  _id: "jx70000000000000000000000holdsti", title: "Row", agent_type: "claude_code", message_count: 4, updated_at: Date.now(), ...over,
}) as any;

const signals = (session: any, over: Record<string, boolean> = {}) =>
  renderToStaticMarkup(<CardStatusSignals session={session} showBlockedBadge={false} isWorking={false} isLive={false} dismissed={false} isPendingWorking={false} isRowRestarting={false} {...over} />);

test("a working card's dot holds still", () => {
  const html = signals(row(), { isWorking: true, isLive: true });
  expect(html).toContain("data-sv-working-dot");
  expect(html).not.toMatch(MOTION);
});

test("a card with a message pending holds still", () => {
  const html = signals(row({ has_pending: true }));
  expect(html).toContain("Message pending");
  expect(html).not.toMatch(MOTION);
});

test("the live dot holds still when a list row asks", () => {
  expect(renderToStaticMarkup(<LivePulseDot still />)).not.toMatch(MOTION);
  expect(renderToStaticMarkup(<LivePulseDot />)).toMatch(MOTION);
});
