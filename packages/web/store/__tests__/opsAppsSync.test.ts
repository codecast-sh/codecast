import { expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

// An app's row (sources/app.capabilities) changes only inside nested values: a
// watch polls, a grant is made in another window, the source's status flips.
// No scalar on the row moves with them, so the collection compares those
// fields by content; without that every push after the first was dropped and
// the Apps tab showed the watch state it first cached, forever.
const SOURCE = "source1".padEnd(32, "0");
const row = (over: Record<string, unknown> = {}) => ({
  _id: SOURCE,
  source: { _id: SOURCE, short_id: "src-1", name: "acme", provider: "app", status: "active" },
  manifest_json: "{}",
  manifest_fetched_at: 1,
  grants: [{ action: "jobs.cancel", granted_by: "u", granted_at: 1 }],
  watch_state: [{ key: "job:jobs.failed", polled_at: 100 }],
  ...over,
});

test("a later push of an app's row lands when only its watch state, grants or source moved", () => {
  const store = () => useInboxStore.getState();
  useInboxStore.setState({ opsApps: {}, pending: {} } as any);
  store().syncTable("opsApps", [row()], { isDelta: true });
  const first = store().opsApps[SOURCE];

  // The same content again is not a change: the row keeps its identity.
  store().syncTable("opsApps", [row()], { isDelta: true });
  expect(store().opsApps[SOURCE]).toBe(first);

  store().syncTable("opsApps", [row({ watch_state: [{ key: "job:jobs.failed", polled_at: 400, last_error: "no answer in 15s" }] })], { isDelta: true });
  expect(store().opsApps[SOURCE].watch_state).toEqual([{ key: "job:jobs.failed", polled_at: 400, last_error: "no answer in 15s" }]);

  store().syncTable("opsApps", [row({ grants: [] })], { isDelta: true });
  expect(store().opsApps[SOURCE].grants).toEqual([]);

  store().syncTable("opsApps", [row({ source: { ...row().source, status: "error", last_error: "manifest: answered 401" } })], { isDelta: true });
  expect(store().opsApps[SOURCE].source.status).toBe("error");
});
