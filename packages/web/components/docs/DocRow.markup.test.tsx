// DocRow markup, frozen across its move out of the docs page
// (heroFly/ARCHITECTURE.md section 3 item 9). The snapshot was written against
// the row while it lived in app/docs/page.tsx; the clock and zone are pinned.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { DocItem } from "../../store/inboxStore";
import { DocRow } from "./DocRow";

process.env.TZ = "UTC";
const NOW = Date.UTC(2026, 8, 30, 18, 0);
Date.now = () => NOW;
const HOUR = 3_600_000;

const base = {
  _id: "hero-d1",
  title: "Webhook retry design",
  doc_type: "design",
  source: "human",
  created_at: NOW - 30 * HOUR,
  updated_at: NOW - 2 * HOUR,
} as unknown as DocItem;

const docs: [string, DocItem][] = [
  ["plain", base],
  ["starred, agent, plan, labels", { ...base, _id: "hero-d2", display_title: "Retry ladder", pinned: true, source: "agent", plan_short_id: "pl-hero1", labels: ["infra", "billing", "launch", "q4"], doc_type: "handoff" } as any],
  ["unknown type, untitled", { ...base, _id: "hero-d3", title: "", doc_type: "mystery", labels: ["one"] } as any],
];

for (const [name, doc] of docs) {
  test(`DocRow: ${name}`, () => {
    expect(renderToStaticMarkup(<MemoryRouter><DocRow doc={doc} state={undefined as any} /></MemoryRouter>)).toMatchSnapshot();
  });
}
