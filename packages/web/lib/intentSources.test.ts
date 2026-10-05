import { describe, expect, test } from "bun:test";
import { intentSourceHref } from "./intentSources";

describe("intentSourceHref", () => {
  test("each kind opens on its own route", () => {
    expect(intentSourceHref({ kind: "task", ref: "ct-12" })).toBe("/tasks/ct-12");
    expect(intentSourceHref({ kind: "plan", ref: "pl-3" })).toBe("/plans/pl-3");
    expect(intentSourceHref({ kind: "session", ref: "jx7c6zk:142" })).toBe("/conversation/jx7c6zk");
    expect(intentSourceHref({ kind: "doc", ref: "abc" })).toBe("/docs/abc");
    expect(intentSourceHref({ kind: "link", ref: "https://x.test/a" })).toBe("https://x.test/a");
    expect(intentSourceHref({ kind: "chat", ref: "ch1/m2" })).toBe("/chat/ch1?m=m2");
    expect(intentSourceHref({ kind: "call", ref: "cl-42" })).toMatch(/^\/calls\/cl-42/);
    expect(intentSourceHref({ kind: "call", ref: "cl-42:15" })).toMatch(/^\/calls\/cl-42/);
  });
  test("a note and a bare chat message open nowhere", () => {
    expect(intentSourceHref({ kind: "note", quote: "x" })).toBeNull();
    expect(intentSourceHref({ kind: "chat", ref: "m2" })).toBeNull();
  });
});
