// A query that names a page leads the palette with Pages, so "ops" goes to
// Ops before any session or role named alike.
import { expect, test } from "bun:test";
import { NAV_PAGES, queryNamesPage } from "../navPages";

const rows = NAV_PAGES.map((page) => ({ page, label: page.label }));

test("an exact name or alias names a page at any length", () => {
  expect(queryNamesPage(rows, "ops", 3)).toBe(true);
  expect(queryNamesPage(rows, "Issues", 3)).toBe(true);
  expect(queryNamesPage(rows, "replays", 3)).toBe(true);
  expect(queryNamesPage(rows, "metrics", 3)).toBe(true);
});

test("a prefix names a page once it is long enough", () => {
  expect(queryNamesPage(rows, "rep", 3)).toBe(true);
  expect(queryNamesPage(rows, "re", 3)).toBe(false);
  expect(queryNamesPage(rows, "re", 1)).toBe(true);
});

test("words that name no page do not", () => {
  expect(queryNamesPage(rows, "ops area improvements", 3)).toBe(false);
  expect(queryNamesPage(rows, "  ", 1)).toBe(false);
});
