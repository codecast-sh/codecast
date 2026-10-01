// Links into a call: every turn, passage, the summary and each action item
// offer one, and a link that lands on the recap opens it.
// Run: bun test components/calls/__tests__/callAnchors.mount.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PassageBlock, RecapCard } from "../RoomThreadRows";
import { buildPassages } from "../roomThreadModel";
import { turnsAnchor } from "../transcriptTurnModel";

const NOW = 1_780_000_000_000;
const segs = [
  { seq: 3, speaker_id: "u-ann", speaker_name: "Ann", text: "Let us split it", t0: 0, t1: 5_000, at: NOW - 60_000 },
  { seq: 4, speaker_id: "u-ann", speaker_name: "Ann", text: "two halves", t0: 5_000, t1: 6_000, at: NOW - 59_000 },
  { seq: 5, speaker_id: "u-bob", speaker_name: "Bob", text: "API half is mine", t0: 6_000, t1: 12_000, at: NOW - 54_000 },
];

describe("call anchors in the thread", () => {
  test("a turn's anchor spans its first to last segment", () => {
    const [p] = buildPassages(segs);
    expect(turnsAnchor([p.turns[0]])).toEqual({ kind: "turns", from_seq: 3, to_seq: 4 });
    expect(turnsAnchor(p.turns)).toEqual({ kind: "turns", from_seq: 3, to_seq: 5 });
  });

  test("passage and turns offer links only when they know their call", () => {
    const [p] = buildPassages(segs);
    const props = { passage: p, idPrefix: "t", open: true, live: false, fresh: false, recording: false, dayOf: NOW, onToggle: () => {} };
    const linked = renderToStaticMarkup(<PassageBlock {...props} callId="call1" />);
    expect(linked).toContain("Copy a link to this passage");
    expect(linked.match(/Copy a link to this turn/g)?.length).toBe(4); // title + aria-label, two turns
    expect(renderToStaticMarkup(<PassageBlock {...props} />)).not.toContain("Copy a link");
  });

  test("the recap stays folded until a link lands on it", () => {
    const props = { summary: "We split it. Bob owns the API.", items: ["Ship the API half", "Review it"], live: false, callId: "call1" };
    expect(renderToStaticMarkup(<RecapCard {...props} />)).not.toContain('data-call-anchor="action-1"');
    const opened = renderToStaticMarkup(<RecapCard {...props} focus="action-1" />);
    expect(opened).toContain('data-call-anchor="summary"');
    expect(opened).toContain('data-call-anchor="action-1"');
    expect(opened).toContain("Copy a link to this action item");
  });
});
