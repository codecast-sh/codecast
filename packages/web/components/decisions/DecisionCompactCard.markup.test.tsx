// The compact decision card's markup, frozen across its container/view split
// (heroFly/ARCHITECTURE.md section 3 item 10). The snapshot was written
// against the card before DecisionCompactCardView existed. The container reads
// the session, task and stack from a substituted store; the view takes the same
// facts as props and must draw the same bytes.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { MemoryRouter } from "react-router";
import { mockInboxStore } from "../__tests__/mockInboxStore";
import type { SessionDecisionItem } from "../../store/inboxStore";

process.env.TZ = "UTC";
const NOW = Date.UTC(2026, 8, 30, 18, 0);
Date.now = () => NOW;
const MIN = 60_000;

const readState = mockInboxStore(() => ({
  sessions: { "hero-c1": { _id: "hero-c1", title: "Webhook retry rewrite", project_path: "/Users/me/src/api" } },
  tasks: { "hero-t1": { _id: "hero-t1", short_id: "ct-hero1", title: "Retry" } },
  decisionStacks: { "hero-s1": { _id: "hero-s1", short_id: "ds-hero1", title: "Launch calls" } },
  messages: {},
}), {
  useTrackedStore: () => readState(),
});

const { DecisionCompactCard, DecisionCompactCardView } = await import("./DecisionCompactCard");

const convex = new ConvexReactClient("https://example.convex.cloud");

const base: SessionDecisionItem = {
  _id: "hero-dec1",
  conversation_id: "hero-c1",
  session_id: "s1",
  question: "Ship the retry ladder behind a flag or straight to everyone?",
  options: [
    { label: "Behind a flag", meaning: "Roll out to 5% first" },
    { label: "Everyone", meaning: "Ship it now" },
  ] as any,
  blocking: true,
  status: "pending",
  created_at: NOW - 12 * MIN,
};

const cases: [string, SessionDecisionItem, Record<string, unknown>?][] = [
  ["pending single, blocking", base],
  ["advisory, human-only category, context, short id", { ...base, _id: "hero-dec2", short_id: "dc-hero2", blocking: false, category: "billing", context_md: "The **old** path drops 3% of webhooks.\n\nA flag costs a day." } as any],
  ["task, station, stack, role holder, recommendation", { ...base, _id: "hero-dec3", task_id: "hero-t1", station: "review", stack_id: "hero-s1", holder: { kind: "role", id: "r1" }, hops: [{ recommendation: 1 }], category: "unknown" } as any],
  ["unknown task id, hidden task", { ...base, _id: "hero-dec4", task_id: "hero-tx" } as any, { showTask: false }],
  ["unknown task id shown", { ...base, _id: "hero-dec5", task_id: "hero-tx" } as any],
  ["multi, selected, cta", { ...base, _id: "hero-dec6", kind: "multi" } as any, { selected: true, onToggleSelect: () => {}, cta: true }],
  ["rank, keys", { ...base, _id: "hero-dec7", kind: "rank" } as any, { keys: true }],
  ["form", { ...base, _id: "hero-dec8", kind: "form" } as any],
  ["answered", { ...base, _id: "hero-dec9", status: "answered", answer_index: 1 }],
  ["unknown session", { ...base, _id: "hero-dec10", conversation_id: "hero-cx", session_title: "Fallback title" } as any],
];

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<ConvexProvider client={convex}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>);

describe("DecisionCompactCard", () => {
  for (const [name, decision, props] of cases) {
    test(name, () => {
      expect(wrap(<DecisionCompactCard decision={decision} {...props} />)).toMatchSnapshot();
    });
  }
});

// The view, fed the same facts the container reads, draws the same bytes.
describe("DecisionCompactCardView", () => {
  const st = readState();
  for (const [name, decision, props] of cases) {
    test(name, () => {
      const view = (
        <DecisionCompactCardView
          decision={decision}
          session={st.sessions[decision.conversation_id]}
          task={decision.task_id ? st.tasks[decision.task_id] : undefined}
          stack={decision.stack_id ? st.decisionStacks[decision.stack_id] : undefined}
          now={NOW}
          onAnswer={() => {}}
          onDismiss={() => {}}
          onJumpToAsk={() => {}}
          {...props}
        />
      );
      expect(wrap(view)).toBe(wrap(<DecisionCompactCard decision={decision} {...props} />));
    });
  }
});
