import { test, expect, describe } from "bun:test";
import { parseSharePath, sharePath, SHARED_OBJECT_KINDS } from "@codecast/shared/entities";
import { isStandaloneSharePath } from "../lib/desktopHandoff";
import { guestJoinPath } from "@codecast/shared/contracts";
import { guestMeetMeta, shareMeta } from "./shareData";

const BASE = "https://codecast.sh";

describe("parseSharePath", () => {
  test("each share kind resolves, bare token = conversation", () => {
    expect(parseSharePath("/share/4c7c324f-3077-486a-a63c-65f188d18a0c"))
      .toEqual({ kind: "conversation", token: "4c7c324f-3077-486a-a63c-65f188d18a0c" });
    expect(parseSharePath("/share/doc/1a221088-1fc3-48c8-a814-71119676adf0"))
      .toEqual({ kind: "doc", token: "1a221088-1fc3-48c8-a814-71119676adf0" });
    expect(parseSharePath("/share/plan/abc123def")).toEqual({ kind: "plan", token: "abc123def" });
    expect(parseSharePath("/share/message/abc123def")).toEqual({ kind: "message", token: "abc123def" });
    expect(parseSharePath("/share/task/abc123def")).toEqual({ kind: "task", token: "abc123def" });
    expect(parseSharePath("/share/call/abc123def")).toEqual({ kind: "call", token: "abc123def" });
  });

  test("sharePath is its inverse for every kind, and every object kind boots standalone", () => {
    for (const kind of ["conversation", ...SHARED_OBJECT_KINDS] as const) {
      const path = sharePath(kind, "abc123def");
      expect(parseSharePath(path)).toEqual({ kind, token: "abc123def" });
      expect(isStandaloneSharePath(path)).toBe(kind !== "conversation");
    }
  });

  test("a guest's meeting link boots standalone too, and nothing else under /meet does", () => {
    expect(isStandaloneSharePath(guestJoinPath("abc123def"))).toBe(true);
    expect(isStandaloneSharePath("/meet/abc123def/")).toBe(true);
    expect(isStandaloneSharePath("/meet")).toBe(false);
    expect(isStandaloneSharePath("/meet/abc/extra")).toBe(false);
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
  test("decision: the choice once made, the options before", () => {
    const options = [{ label: "Ship" }, { label: "Wait" }];
    expect(shareMeta("decision", "t", { question: "Ship now?", status: "pending", options }, BASE)?.description).toBe("Options: Ship, Wait");
    const done = shareMeta("decision", "t", { question: "Ship now?", status: "answered", answer_index: 1, options }, BASE);
    expect(done?.title).toBe("Codecast: Ship now?");
    expect(done?.description).toBe("Decided: Wait");
    expect(done?.url).toBe(`${BASE}/share/decision/t`);
  });

  test("run: goal, else step tally", () => {
    const meta = shareMeta("run", "t", { name: "Audit", nodes: [{ status: "completed" }, { status: "running" }] }, BASE);
    expect(meta?.description).toBe("1 of 2 steps done");
  });

  test("task: description peek, else its id and status", () => {
    const meta = shareMeta("task", "t", { title: "Fix login", short_id: "ct-9", status: "in_progress", description: "" }, BASE);
    expect(meta?.title).toBe("Codecast: Fix login");
    expect(meta?.description).toBe("ct-9, in progress");
    expect(meta?.url).toBe(`${BASE}/share/task/t`);
  });

  test("call: the recap, else who was on it", () => {
    const withSummary = shareMeta("call", "t", { title: "Standup", summary: "We **shipped** it", participants: [] }, BASE);
    expect(withSummary?.description).toBe("We shipped it");
    const noSummary = shareMeta("call", "t", { recording: false, participants: [{ name: "Ada" }, { name: "Sam" }] }, BASE);
    expect(noSummary?.title).toBe("Codecast: Shared Huddle");
    expect(noSummary?.description).toBe("A call with Ada, Sam");
  });

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

describe("guestMeetMeta", () => {
  const live = { ok: true, title: "#design", inviter: { name: "Sam Lee" }, live: true, transcribed: true, recording: false };

  test("an open link names the meeting, who invited, and what is kept", () => {
    expect(guestMeetMeta("tok12345", live, BASE)).toEqual({
      title: "Join: #design",
      description: "Sam Lee invited you to join. Join from your browser, no account needed. This call is transcribed.",
      url: `${BASE}/meet/tok12345`,
    });
    expect(guestMeetMeta("tok12345", { ...live, title: null, recording: true, transcribed: false }, BASE)?.title).toBe("Join: A call with Sam");
    expect(guestMeetMeta("tok12345", { ...live, recording: true }, BASE)?.description).toContain("recorded and transcribed");
  });

  test("a closed link says so in the guest's words, and invites nobody", () => {
    const meta = guestMeetMeta("tok12345", { ok: false, reason: "expired" }, BASE);
    expect(meta?.title).toBe("codecast: this meeting link is closed");
    expect(meta?.description).toContain("expired");
  });
});
