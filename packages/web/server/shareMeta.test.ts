import { test, expect, describe } from "bun:test";
import { parseSharePath } from "@codecast/shared/entities";
import { shareMeta } from "./shareData";

const BASE = "https://codecast.sh";

describe("parseSharePath", () => {
  test("each share kind resolves, bare token = conversation", () => {
    expect(parseSharePath("/share/4c7c324f-3077-486a-a63c-65f188d18a0c"))
      .toEqual({ kind: "conversation", token: "4c7c324f-3077-486a-a63c-65f188d18a0c" });
    expect(parseSharePath("/share/doc/1a221088-1fc3-48c8-a814-71119676adf0"))
      .toEqual({ kind: "doc", token: "1a221088-1fc3-48c8-a814-71119676adf0" });
    expect(parseSharePath("/share/plan/abc123def")).toEqual({ kind: "plan", token: "abc123def" });
    expect(parseSharePath("/share/message/abc123def")).toEqual({ kind: "message", token: "abc123def" });
  });

  test("query strings, fragments and trailing slashes do not change the token", () => {
    expect(parseSharePath("/share/abc123def?utm=x#msg-5")?.token).toBe("abc123def");
    expect(parseSharePath("/share/doc/abc123def/")?.kind).toBe("doc");
  });

  test("what is not a share link stays out", () => {
    expect(parseSharePath("/share/")).toBeNull();
    expect(parseSharePath("/share/doc/")).toBeNull();
    expect(parseSharePath("/share/doc/abc/extra")).toBeNull();
    expect(parseSharePath("/shared/abc123def")).toBeNull();
    expect(parseSharePath("/conversation/abc")).toBeNull();
    // A sub-kind word alone is a malformed link, not a conversation token.
    expect(parseSharePath("/share/doc")).toBeNull();
  });
});

describe("shareMeta", () => {
  test("doc: title plus a markdown-stripped body peek", () => {
    const meta = shareMeta("doc", "tok123", {
      title: "US connector taxonomy",
      doc_type: "note",
      content: "# Heading\n\nA **US-focused** taxonomy of people\n\n```js\ncode()\n```",
      user: { name: "Ashot" },
    }, BASE);
    expect(meta?.title).toBe("Codecast: US connector taxonomy");
    expect(meta?.description).toBe("Heading A US-focused taxonomy of people");
    expect(meta?.url).toBe(`${BASE}/share/doc/tok123`);
  });

  test("doc with empty body falls back to author attribution", () => {
    const meta = shareMeta("doc", "t", { title: "T", doc_type: "spec", content: "", user: { name: "Sam" } }, BASE);
    expect(meta?.description).toBe("A spec shared by Sam");
  });

  test("plan: goal first, task tally as fallback", () => {
    const withGoal = shareMeta("plan", "t", { title: "P", goal: "Ship it", tasks: [] }, BASE);
    expect(withGoal?.description).toBe("Ship it");
    const noGoal = shareMeta("plan", "t", {
      title: "P",
      tasks: [{ status: "done" }, { status: "done" }, { status: "open" }],
    }, BASE);
    expect(noGoal?.description).toBe("2/3 tasks done");
  });

  test("message: note wins, then the message body", () => {
    const meta = shareMeta("message", "t", {
      conversation: { title: "Fix the race" },
      message: { role: "assistant", content: "The `flush` path was starved" },
      user: { name: "Ashot" },
    }, BASE);
    expect(meta?.title).toBe("Codecast: Fix the race");
    expect(meta?.description).toBe("The flush path was starved");
  });

  test("conversation: bare-token url and author line", () => {
    const meta = shareMeta("conversation", "tok", { title: "Session", description: "", message_count: 12, author: "Sam" }, BASE);
    expect(meta?.url).toBe(`${BASE}/share/tok`);
    expect(meta?.description).toBe("12 messages by Sam");
  });

  test("an unknown token unfurls nothing", () => {
    expect(shareMeta("doc", "t", null, BASE)).toBeNull();
  });
});
