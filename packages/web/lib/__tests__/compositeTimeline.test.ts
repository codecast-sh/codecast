// The transcript builder. ConversationView casts this function's result to its
// own local copy of TimelineItem, so the compiler cannot catch a disagreement
// about the item type string. These tests are what does.
import { describe, expect, it } from "bun:test";
import { buildCompositeTimeline, type TimelineItem } from "../compositeTimeline";

const msg = (id: string, timestamp: number) => ({ _id: id, role: "user", content: id, timestamp });
const commit = (id: string, sha: string, timestamp: number) => ({ _id: id, sha, message: id, timestamp });
const event = (id: string, created_at: number, extra: Record<string, unknown> = {}) => ({
  _id: id,
  kind: "push",
  title: id,
  created_at,
  ...extra,
});

const typesOf = (items: TimelineItem[]) => items.map((i) => i.type);

describe("buildCompositeTimeline", () => {
  it("names an external event item 'external_event'", () => {
    // ConversationView branches on this exact string in four places: the row
    // key, the height estimate, the render branch and the item id. A rename on
    // one side and not the other paints nothing at all.
    const items = buildCompositeTimeline([msg("m1", 100)], [], [], [event("e1", 200)]);
    expect(typesOf(items)).toEqual(["message", "external_event"]);
  });

  it("sorts events among the messages by time", () => {
    const items = buildCompositeTimeline(
      [msg("m1", 100), msg("m2", 300)],
      [],
      [],
      [event("e1", 200)],
    );
    expect(items.map((i) => i.timestamp)).toEqual([100, 200, 300]);
    expect(typesOf(items)).toEqual(["message", "external_event", "message"]);
  });

  it("drops a commit that also arrived as an event with the same sha", () => {
    const items = buildCompositeTimeline(
      [msg("m1", 100)],
      [commit("c1", "abc123", 150)],
      [],
      [event("e1", 150, { sha: "abc123" })],
    );
    expect(typesOf(items)).toEqual(["message", "external_event"]);
  });

  it("keeps a commit whose sha no event claims", () => {
    const items = buildCompositeTimeline(
      [msg("m1", 100)],
      [commit("c1", "abc123", 150)],
      [],
      [event("e1", 160, { sha: "different" })],
    );
    expect(typesOf(items)).toEqual(["message", "commit", "external_event"]);
  });

  it("keeps a commit that carries no sha at all", () => {
    const items = buildCompositeTimeline(
      [msg("m1", 100)],
      [{ _id: "c1", sha: "", message: "local", timestamp: 150 }],
      [],
      [event("e1", 160, { sha: "abc123" })],
    );
    expect(typesOf(items)).toEqual(["message", "commit", "external_event"]);
  });

  it("returns the cached array when nothing changed, and a new one when events do", () => {
    const messages = [msg("m1", 100)];
    const commits: any[] = [];
    const prs: any[] = [];
    const events = [event("e1", 200)];
    const first = buildCompositeTimeline(messages, commits, prs, events);
    expect(buildCompositeTimeline(messages, commits, prs, events)).toBe(first);
    // A new events array must not be served the cached result: that was the
    // whole reason the cache had to learn about this fourth input.
    const second = buildCompositeTimeline(messages, commits, prs, [...events, event("e2", 300)]);
    expect(second).not.toBe(first);
    expect(second).toHaveLength(3);
  });

  it("still works for callers that pass no events", () => {
    const items = buildCompositeTimeline([msg("m1", 100)], [commit("c1", "abc", 150)], []);
    expect(typesOf(items)).toEqual(["message", "commit"]);
  });
});
