import { test, expect, describe } from "bun:test";
import {
  defaultOpenEntry,
  openEntryExpired,
  resolveOpenEntry,
  toggledOpenEntry,
  type ThreadCardModel,
} from "./threadCards";

// The open-by-default rules: every card renders expanded, the user's collapse
// holds until NEWER unread lands, and a fresh visit re-derives `auto` entries
// without touching the user's own.

const T0 = 1_700_000_000_000;

function card(unread: number, activityAt = T0, lastReadAt = T0 - 1000): ThreadCardModel {
  return {
    id: "task:t1",
    kind: "task",
    chip: "task",
    activityAt,
    unread,
    href: "/tasks/t1",
    source: { _id: "task:t1", kind: "task", root_key: "t1", last_activity_at: activityAt, last_read_at: lastReadAt, updated_at: activityAt, unread } as any,
  };
}

describe("defaultOpenEntry", () => {
  test("every card opens, read or not, boundary frozen from the row", () => {
    expect(defaultOpenEntry(card(3))).toEqual({ expanded: true, by: "auto", at: T0, frozenReadAt: T0 - 1000 });
    expect(defaultOpenEntry(card(0)).expanded).toBe(true);
  });
});

describe("resolveOpenEntry", () => {
  test("no entry falls back to the default", () => {
    expect(resolveOpenEntry(card(2), undefined, false).expanded).toBe(true);
    expect(resolveOpenEntry(card(0), undefined, false).expanded).toBe(true);
  });

  test("a user collapse of an unread card holds while nothing newer lands", () => {
    const c = card(2);
    const collapsed = toggledOpenEntry(c, defaultOpenEntry(c));
    expect(collapsed).toMatchObject({ expanded: false, by: "user", at: T0 });
    // Same unread, same activity: the collapse stands.
    expect(resolveOpenEntry(c, collapsed, false)).toBe(collapsed);
    // Newer unread: the card re-earns its default-open.
    const newer = card(3, T0 + 5000);
    expect(openEntryExpired(newer, collapsed)).toBe(true);
    expect(resolveOpenEntry(newer, collapsed, false).expanded).toBe(true);
  });

  test("a fresh visit re-derives auto entries but honors user ones", () => {
    // Read since last visit: the auto entry re-derives, and still opens.
    const wasOpen = defaultOpenEntry(card(2));
    expect(resolveOpenEntry(card(0), wasOpen, true).expanded).toBe(true);
    // Mid-visit, the same card marking itself read stays open under the reader.
    expect(resolveOpenEntry(card(0), wasOpen, false)).toBe(wasOpen);
    // The user's collapse of a read card survives the next visit.
    const c = card(0);
    const userClosed = toggledOpenEntry(c, defaultOpenEntry(c));
    expect(userClosed.expanded).toBe(false);
    expect(resolveOpenEntry(c, userClosed, true)).toBe(userClosed);
  });

  test("a collapsed read card stays collapsed until newer unread lands", () => {
    const c = card(0);
    const closed = toggledOpenEntry(c, defaultOpenEntry(c));
    expect(resolveOpenEntry(card(0, T0 + 5000), closed, false)).toBe(closed);
    expect(resolveOpenEntry(card(1, T0 + 5000), closed, false).expanded).toBe(true);
  });

  test("expanding freezes the unread boundary at expand time", () => {
    const c = card(1, T0, T0 - 60_000);
    const entry = toggledOpenEntry(c, { expanded: false, by: "user", at: T0, frozenReadAt: 0 });
    expect(entry.frozenReadAt).toBe(T0 - 60_000);
    // Collapsing keeps the frozen boundary rather than re-reading the row.
    const closed = toggledOpenEntry(c, entry);
    expect(closed.frozenReadAt).toBe(T0 - 60_000);
  });
});
