import { describe, expect, test } from "bun:test";
import { canvasHrefToRoute } from "./canvasLinks";

describe("canvasHrefToRoute", () => {
  test("conversation URL with a message anchor keeps the fragment", () => {
    expect(
      canvasHrefToRoute("https://codecast.sh/conversation/jx7e0n1ss95jc73je51xpc6rah8daawr#msg-k176qce1"),
    ).toBe("/conversation/jx7e0n1ss95jc73je51xpc6rah8daawr#msg-k176qce1");
  });

  test("conversation URL without an anchor", () => {
    expect(canvasHrefToRoute("https://codecast.sh/conversation/jx7ag8x7d4ch9c4qbkye0nsjg98d96w0")).toBe(
      "/conversation/jx7ag8x7d4ch9c4qbkye0nsjg98d96w0",
    );
  });

  test("task and doc URLs route to their pages", () => {
    expect(canvasHrefToRoute("https://codecast.sh/tasks/ct-47124")).toBe("/tasks/ct-47124");
    expect(canvasHrefToRoute("/docs/abc123")).toBe("/docs/abc123");
  });

  test("a GitHub pull request or commit link opens the app's page for it", () => {
    expect(canvasHrefToRoute("https://github.com/foo/bar/pull/1")).toBe("/pr/foo/bar/1");
    expect(canvasHrefToRoute("https://github.com/foo/bar/commit/aa57b85ee")).toBe("/commit/foo/bar/aa57b85ee");
  });

  test("external links stay external", () => {
    expect(canvasHrefToRoute("https://github.com/foo/bar")).toBeNull();
    expect(canvasHrefToRoute("https://example.com/foo/bar/pull/1")).toBeNull();
    expect(canvasHrefToRoute("mailto:hi@example.com")).toBeNull();
    expect(canvasHrefToRoute("#local-anchor")).toBeNull();
    expect(canvasHrefToRoute(null)).toBeNull();
    expect(canvasHrefToRoute("")).toBeNull();
  });

  test("non-entity app paths stay external", () => {
    expect(canvasHrefToRoute("https://codecast.sh/settings")).toBeNull();
    expect(canvasHrefToRoute("https://codecast.sh/a/somepublishedpage")).toBeNull();
  });
});
