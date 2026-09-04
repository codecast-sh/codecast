import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseTabLocation } from "../tabParams";
import { repositoryJump } from "../repoNavigation";
import { toAppHref, toStandaloneHref } from "../repoView";

test("a palette file jump keeps its line range out of the filename", () => {
  const target = repositoryJump("codecast-sh/shepherd-lab@main:shepherd.md#L2-L3")!;
  const location = parseTabLocation(target.href);
  expect(location.pathname).toBe("/repo/codecast-sh/shepherd-lab/blob/main");
  expect(location.searchParams.get("path")).toBe("shepherd.md");
  expect(location.hash).toBe("#L2-L3");
});

test("encoded delimiters belong to filenames, literal fragments do not", () => {
  const location = parseTabLocation("/repo/o/r/blob/feature%2Fone?path=docs%2Fwhy%3F%23.md&session=jxabc#L4");
  expect(location.pathname).toBe("/repo/o/r/blob/feature%2Fone");
  expect(location.searchParams.get("path")).toBe("docs/why?#.md");
  expect(location.searchParams.get("session")).toBe("jxabc");
  expect(location.hash).toBe("#L4");
});

test("fragment-only navigation does not invent a query", () => {
  const location = parseTabLocation("/docs/test#heading?not-a-query");
  expect(location.pathname).toBe("/docs/test");
  expect(location.searchParams.size).toBe(0);
  expect(location.hash).toBe("#heading?not-a-query");
});

test("RoutePane uses the URL parser rather than splitting query text", () => {
  const source = readFileSync(new URL("../../components/RoutePane.tsx", import.meta.url), "utf8");
  expect(source).toContain("...parseTabLocation(path)");
  expect(source).not.toContain("new URLSearchParams(queryString");
});

test("pop-out and return preserve the same file and line range", () => {
  const href = repositoryJump("codecast-sh/shepherd-lab@main:shepherd.md#L2-L3")!.href;
  const { pathname, searchParams, hash } = parseTabLocation(href);
  const standalone = toStandaloneHref(`${pathname}?${searchParams}${hash}`);
  expect(standalone).toBe("/r/codecast-sh/shepherd-lab/blob/main?path=shepherd.md#L2-L3");
  expect(toAppHref(standalone)).toBe(href);
  const control = readFileSync(new URL("../../components/repo/RepoWindowControl.tsx", import.meta.url), "utf8");
  expect(control).toContain("pathname + search + hash");
  const blob = readFileSync(new URL("../../app/repo/[owner]/[name]/blob/[ref]/page.tsx", import.meta.url), "utf8");
  expect(blob).toContain("router.replace(`${pathname}${search}${formatLineHash(next)}`");
  expect(blob).not.toContain("window.history.replaceState(");
});
