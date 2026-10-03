/**
 * Chapter 11, Publish: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * The beat: the lead session answers with a canvas (the retry report as a
 * chart), runs `cast publish`, and the report becomes the page
 * codecast.sh/a/webhook-retries, and two teammates comment on it. The page
 * itself is built ahead of time by scripts/hero-page.ts from PAGE.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import { readyAt } from "../world";
import { CUES, MIN, OBJECTS, PEOPLE, SESSIONS } from "./story";

/** Film-time cues inside the chapter (the camera holds 69.2 to 73.9). */
export const PUBLISH = {
  /** The canvas reply is in place before the page's surface turns face-up, so it turns over onto it. */
  reply: readyAt("page"),
  command: 69.7,
  published: CUES.published,
} as const;

/** The report, as the generated page and the canvas both tell it. */
export const PAGE = {
  ...OBJECTS.page,
  author: PEOPLE.me.name,
  views: 14,
  session: { id: SESSIONS.lead.id, shortId: SESSIONS.lead.shortId, title: SESSIONS.lead.title },
  attempts: [
    { label: "1st retry", share: 82 },
    { label: "2nd", share: 13 },
    { label: "3rd", share: 4 },
    { label: "4th", share: 1 },
    { label: "5th", share: 0 },
  ],
  reasons: [
    { reason: "502 from the ledger", events: 25, recovered: "25 of 25" },
    { reason: "Timeout after 10s", events: 11, recovered: "11 of 11" },
    { reason: "429 rate limited", events: 4, recovered: "4 of 4" },
    { reason: "Connection reset", events: 1, recovered: "1 of 1" },
  ],
  comments: [
    // Anchored on the chart (fractions of the generated page), clear of the discussion docked on the right.
    { id: "hero-cm1", author: "Sarah Chen", text: "Can we page someone when an event reaches attempt 5?", anchor: { x: 0.418, y: 0.725 } },
    { id: "hero-cm2", author: "Maya Ortiz", text: "Putting this chart on the billing dashboard.", anchor: { x: 0.31, y: 0.535 } },
  ],
};

/** The canvas the session replies with: the same numbers, drawn in the conversation. */
const bars = PAGE.attempts
  .map((a, i) => {
    const h = Math.max(2, Math.round((a.share / 100) * 96));
    const x = 14 + i * 76;
    return `<rect x="${x}" y="${112 - h}" width="52" height="${h}" rx="4" fill="var(--sol-blue)" opacity="${i === 0 ? 1 : 0.45}"/><text x="${x + 26}" y="${106 - h}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--sol-text)">${a.share}%</text><text x="${x + 26}" y="128" text-anchor="middle" font-size="10" fill="var(--sol-text-muted)">${a.label}</text>`;
  })
  .join("");

export const CANVAS = `<div data-canvas-title="Webhook retries, last 24h replayed on staging" style="display:grid;gap:12px;font-family:inherit">
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
<div style="padding:8px 10px;border:1px solid var(--sol-border);border-radius:8px"><div style="font-size:18px;font-weight:600;color:var(--sol-green)">0</div><div style="font-size:11px;color:var(--sol-text-muted)">events dropped</div></div>
<div style="padding:8px 10px;border:1px solid var(--sol-border);border-radius:8px"><div style="font-size:18px;font-weight:600;color:var(--sol-text)">99.98%</div><div style="font-size:11px;color:var(--sol-text-muted)">delivered</div></div>
<div style="padding:8px 10px;border:1px solid var(--sol-border);border-radius:8px"><div style="font-size:18px;font-weight:600;color:var(--sol-text)">2m 10s</div><div style="font-size:11px;color:var(--sol-text-muted)">median recovery</div></div>
</div>
<svg viewBox="0 0 396 136" width="100%" role="img" aria-label="Where a failed event recovers">${bars}<line x1="8" y1="112" x2="388" y2="112" stroke="var(--sol-border)"/></svg>
</div>`;

export const REPLY = {
  ago: 2 * MIN,
  content: `I replayed the last 24 hours of failed deliveries on staging. Every one recovered, most on the first retry.\n\n\`\`\`cast-canvas\n${CANVAS}\n\`\`\``,
  command: `cast publish report.html --title "${PAGE.title}"`,
  output: `Published ${PAGE.title}\nhttps://${PAGE.url}`,
};

export const entities: Record<string, EntityFixture> = {};
