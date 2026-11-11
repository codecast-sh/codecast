import { describe, expect, it } from "bun:test";
import { displayPath, resolveAddress } from "../appAddress";

describe("resolveAddress", () => {
  it("keeps an in-app path as it is", () => {
    expect(resolveAddress("/tasks/ct-12")).toEqual({ kind: "app", path: "/tasks/ct-12" });
    expect(resolveAddress("  /inbox?s=jx7abcd ")).toEqual({ kind: "app", path: "/inbox?s=jx7abcd" });
  });

  it("opens a codecast link from any copy of the app here", () => {
    expect(resolveAddress("https://codecast.sh/plans/pl-88#step-2")).toEqual({ kind: "app", path: "/plans/pl-88#step-2" });
    expect(resolveAddress("http://local.codecast.sh/org?proposal=op-19")).toEqual({ kind: "app", path: "/org?proposal=op-19" });
    expect(resolveAddress("codecast.sh/docs")).toEqual({ kind: "app", path: "/docs" });
  });

  it("opens a short id on its object's page", () => {
    expect(resolveAddress("ct-4102")).toEqual({ kind: "app", path: "/tasks/ct-4102" });
    expect(resolveAddress("pl-88")).toEqual({ kind: "app", path: "/plans/pl-88" });
  });

  it("sends any other web address to a pane", () => {
    expect(resolveAddress("https://github.com/codecast-sh/codecast")).toEqual({ kind: "web", url: "https://github.com/codecast-sh/codecast" });
    expect(resolveAddress("example.com/x")).toEqual({ kind: "web", url: "https://example.com/x" });
    expect(resolveAddress("localhost:3000")).toEqual({ kind: "web", url: "http://localhost:3000/" });
  });

  it("reads a bare route as a path", () => {
    expect(resolveAddress("inbox")).toEqual({ kind: "app", path: "/inbox" });
    expect(resolveAddress("tasks/ct-12")).toEqual({ kind: "app", path: "/tasks/ct-12" });
  });

  it("leaves a word that names no page to the title search", () => {
    expect(resolveAddress("head")).toBeNull();
    expect(resolveAddress("fixes")).toBeNull();
  });

  it("refuses prose, other schemes and protocol-relative links", () => {
    expect(resolveAddress("two words")).toBeNull();
    expect(resolveAddress("")).toBeNull();
    expect(resolveAddress("//evil.com/x")).toBeNull();
    expect(resolveAddress("javascript:alert(1)")).toBeNull();
    expect(resolveAddress("file:///etc/passwd")).toBeNull();
  });
});

describe("displayPath", () => {
  it("shortens full ids and leaves everything else", () => {
    expect(displayPath("/conversation/jx79x026g1zmyaew7zzjk85wmn8grre3")).toBe("/conversation/jx79x02…");
    expect(displayPath("/tasks/ct-12?view=board")).toBe("/tasks/ct-12?view=board");
    expect(displayPath("/conversation/2c4hco8eepm8geugdewmz6")).toBe("/conversation/2c4hco8…");
  });

  it("shows a browser pane as the page it holds", () => {
    expect(displayPath("/browser?u=https%3A%2F%2Fexample.com%2Fdocs")).toBe("example.com/docs");
  });
});
