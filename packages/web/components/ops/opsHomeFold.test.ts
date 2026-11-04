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
