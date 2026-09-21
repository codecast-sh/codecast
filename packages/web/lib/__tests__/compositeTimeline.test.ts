// The transcript builder. ConversationView casts this function's result to its
// own local copy of TimelineItem, so the compiler cannot catch a disagreement
// about the item type string. These tests are what does.
import { describe, expect, it } from "bun:test";
import { buildCompositeTimeline, mergeTimelineMessages, type TimelineItem } from "../compositeTimeline";

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

describe("mergeTimelineMessages", () => {
  it("places a persisted interruption before newer replies so the tail keeps the latest activity time", () => {
    const latest = 1_790_000_000_000;
    const interruption = {
      ...msg("old-interrupt", latest - 6 * 24 * 60 * 60 * 1000),
      content: "[Request interrupted by user]",
      _isSettledControl: true,
    };
    const reply = { ...msg("latest-reply", latest), role: "assistant" };
    const base = buildCompositeTimeline([reply], [], []);
    const items = mergeTimelineMessages(base, [interruption]);
    expect(items.map((item) => item.data._id)).toEqual(["old-interrupt", "latest-reply"]);
    expect(items.at(-1)?.timestamp).toBe(latest);
    expect(items[0].data).toBe(interruption);
    expect(base).toHaveLength(1);
    expect(base[0].data).toBe(reply);
  });

  it("orders local and server pending messages among messages, commits, PRs, and events", () => {
    const base = buildCompositeTimeline(
      [msg("reply", 500)],
      [commit("commit", "sha", 200)],
      [{ _id: "pr", number: 1, title: "PR", state: "open", created_at: 400 }],
      [event("event", 600)],
    );
    const pending = [
      { ...msg("latest-pending", 700), _isOptimistic: true },
      { ...msg("serverpending_1", 300), _serverPendingStatus: "queued" },
      { ...msg("old-interrupt", 100), content: "<turn_aborted>" },
    ];
    const items = mergeTimelineMessages(base, pending);
    expect(items.map((item) => item.data._id)).toEqual([
      "old-interrupt", "commit", "serverpending_1", "pr", "reply", "event", "latest-pending",
    ]);
  });

  it("preserves arrival order for equal timestamps", () => {
    const base = buildCompositeTimeline([msg("reply", 100)], [], []);
    const items = mergeTimelineMessages(base, [msg("interrupt", 100), msg("follow-up", 100)]);
    expect(items.map((item) => item.data._id)).toEqual(["reply", "interrupt", "follow-up"]);
  });

  it("reuses the base when there are no pending messages", () => {
    const base = buildCompositeTimeline([msg("reply", 100)], [], []);
    expect(mergeTimelineMessages(base, [])).toBe(base);
  });
});

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
