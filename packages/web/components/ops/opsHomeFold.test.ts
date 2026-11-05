import { expect, test } from "bun:test";
import { attentionItems } from "./opsHomeModel";
import { itemTitle } from "./opsHomeItems";
import { foldIssueRows, foldedTitle, routeTitle } from "./issuesModel";
import type { OpsGroup, OpsSource } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 4, 12);
const H = 3600_000;

const source = (over: Partial<OpsSource> = {}): OpsSource => ({
  _id: "s1", short_id: "src-1", workspace: "team:t", owner_user_id: "u", provider: "posthog", name: "union-posthog", keyed: true,
  promote: [], status: "active", last_event_at: NOW - 60_000, created_at: NOW - 30 * 24 * H, updated_at: NOW, ...over,
});
const group = (over: Partial<OpsGroup> = {}): OpsGroup => ({
  _id: "g1", workspace: "team:t", source_id: "s1", short_id: "eg-1", kind: "replay_issue", fingerprint: "f", title: "TypeError",
  status: "open", first_seen: NOW - 2 * H, last_seen: NOW - H, count: 3, buckets: [], updated_at: NOW, ...over,
});

const byPhone = (n: string, over: Partial<OpsGroup> = {}) => group({ title: `GET /api/contacts/by-phone/${n} answers 404`, ...over });

test("a path's records read as its route: ids, phone numbers and emails", () => {
  expect(routeTitle("GET /api/contacts/by-phone/%2B447754757715 answers 404")).toBe("GET /api/contacts/by-phone/:id answers 404");
  expect(routeTitle("TypeError: x is undefined")).toBeNull();
});

test("one endpoint failing for two callers folds into one row titled by its route, however short the title", () => {
  const rows = [byPhone("%2B447754757715", { _id: "a", count: 5 }), byPhone("%2B17864864391", { _id: "b", count: 2 }), group({ _id: "c", title: "GET /api/contacts/:id answers 404" })];
  const out = foldIssueRows(rows, (g) => g, (g) => g.count);
  expect(out.map((c) => c.map((g) => g._id))).toEqual([["a", "b"], ["c"]]);
  expect(foldedTitle(out[0].map((g) => g.title))).toBe("GET /api/contacts/by-phone/:id answers 404");
});

test("another status on the same route is another failure", () => {
  const out = foldIssueRows([byPhone("%2B1", { _id: "a" }), group({ _id: "b", title: "GET /api/contacts/by-phone/%2B2 answers 500" })], (g) => g, (g) => g.count);
  expect(out).toHaveLength(2);
});

test("the home lists the folded pair once, with no phone number in its title", () => {
  const groups = [byPhone("%2B447754757715", { _id: "a", short_id: "eg-2062", first_seen: NOW - H }), byPhone("%2B17864864391", { _id: "b", short_id: "eg-2059", first_seen: NOW - H })];
  const items = attentionItems({ sources: [source()], groups, watches: [], replays: [] }, NOW, () => undefined).filter((it) => it.kind === "issue");
  expect(items).toHaveLength(1);
  expect(itemTitle(items[0])).toBe("GET /api/contacts/by-phone/:id answers 404");
});

test("request ids name no cause: one function's errors fold into one row titled without them, two functions never fold", async () => {
  const { dropRequestIds } = await import("@codecast/shared/contracts/signalFingerprint");
  const { errorTitle } = await import("@codecast/shared/contracts/ingest");
  const convex = (id: string, fn: string, rid: string, count: number) => group({ _id: id, short_id: `eg-${id}`, kind: "error", last_release: "unknown", count, title: `[CONVEX M(${fn})] [Request ID: ${rid}] Server Error` });
  const rows = [convex("1809", "dispatch:dispatch", "65293c3ba5e64535", 3), convex("1427", "dispatch:dispatch", "9453b3fc4914731c", 8), convex("626", "orgHealth:healthReport", "0eb30e7cfd1fc93d", 38)];
  const out = foldIssueRows(rows, (g) => g, (g) => g.count);
  expect(out.map((c) => c.map((g) => g._id).sort())).toEqual([["1427", "1809"], ["626"]]);
  expect(foldedTitle(out[0].map((g) => g.title))).toBe("[CONVEX M(dispatch:dispatch)] Server Error");
  expect(dropRequestIds("[CONVEX Q(org:tree)] [Request ID: 5349b679b4bfcf3b] Server Error")).toBe("[CONVEX Q(org:tree)] Server Error");
  // New groups are titled without it on the server (errorTitle is the ingest's title rule).
  expect(errorTitle("[CONVEX Q(org:tree)] [Request ID: 5349b679b4bfcf3b] Server Error").title).toBe("[CONVEX Q(org:tree)] Server Error");
  // A single issue's row reads the same way.
  const items = attentionItems({ sources: [source({ provider: "sdk" })], groups: [rows[2]], watches: [], replays: [] }, NOW, () => undefined);
  expect(itemTitle(items[0])).toBe("[CONVEX M(orgHealth:healthReport)] Server Error");
});

test("two causes filed under one problem task fold into one row under it, and Nobody on it counts issues", () => {
  const a = group({ _id: "a", short_id: "eg-2071", title: "Failed to update call status: RpcError: HTTP 502", count: 4, signal_task_id: "t1" });
  const b = group({ _id: "b", short_id: "eg-2056", title: "Failed to update call status", count: 1, signal_task_id: "t1" });
  const c = group({ _id: "c", short_id: "eg-9", title: "Something else entirely broke here today", count: 2 });
  const items = attentionItems({ sources: [source()], groups: [a, b, c], watches: [], replays: [], taskOf: () => ({ status: "open", assignee: null }) }, NOW, () => undefined);
  expect(items).toHaveLength(2);
  const folded = items.find((it) => it.kind === "issue" && it.variants)!;
  expect(folded.kind === "issue" && folded.variants!.map((g) => g.short_id)).toEqual(["eg-2071", "eg-2056"]);
  expect(itemTitle(folded)).toBe("Failed to update call status …");
  expect(folded.taskId).toBe("t1");
  expect(folded.unowned).toBe(2);
});
