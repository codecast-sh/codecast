import { describe, expect, test } from "bun:test";
import { buildMentionContext, mentionContextFor } from "../mentionContext";
import { groupMentionItems, mergeMentionSuggestions, orderMentionItems } from "../mentionRanking";
import { chatDraftKey } from "../chatDraftKey";
import type { MentionItem } from "../mentionItem";

const session = (id: string, label: string, updatedAt = 0): MentionItem => ({ id: `${id}xxxxxxxxxxxxxxxxxxxxxxxxx`, type: "session", label, shortId: id, updatedAt });
const person = (id: string, name: string, handle: string): MentionItem => ({ id, type: "person", label: name, handle });
const task = (shortId: string, label: string, updatedAt = 0): MentionItem => ({ id: `t-${shortId}`, type: "task", label, shortId, updatedAt });
const channel = (id: string, name: string, updatedAt = 0): MentionItem => ({ id, type: "channel", label: name, updatedAt });

describe("mention context", () => {
  test("with nothing typed, what the conversation names leads, latest mention first", () => {
    const ctx = buildMentionContext(["look at ct-12 please", "and @[Auth race jx7abcd] too", "cc @maya"]);
    const items = [task("ct-99", "Newest task", 900), task("ct-12", "Cited task", 1), session("jx7abcd", "Auth race", 2), person("u1", "Maya", "maya"), person("u2", "Sam", "sam")];
    expect(mergeMentionSuggestions(items, [], new Map(), Infinity, "", false, ctx).map((m) => m.label))
      .toEqual(["Maya", "Auth race", "Cited task", "Newest task", "Sam"]);
  });

  test("a cited item beats an equal name match, never a stronger one", () => {
    const ctx = buildMentionContext(["see jx7abcd"]);
    const items = [person("u1", "Ashot", "ashot"), session("jx7abcd", "Ash tree cleanup", 1), session("jx7zzzz", "Ashes", 5), session("jx7yyyy", "fix", 9)];
    const ranked = mergeMentionSuggestions(items, [], new Map(), Infinity, "ash", false, ctx).map((m) => m.label);
    expect(ranked.slice(0, 2)).toEqual(["Ash tree cleanup", "Ashot"]);
    expect(ranked).toContain("Ashes");
  });

  test("speakers in a chat thread count, the viewer does not", () => {
    const key = chatDraftKey("c1", "root");
    const ctx = mentionContextFor({
      chatMessages: {
        root: { _id: "root", channel_id: "c1", content: "deploy is stuck", user_id: "u1", created_at: 1 },
        r1: { _id: "r1", channel_id: "c1", thread_root_id: "root", content: "looking #infra", user_id: "me", created_at: 2 },
        other: { _id: "other", channel_id: "c1", content: "unrelated @sam", user_id: "u2", created_at: 3 },
      },
    }, key, "me");
    expect([...ctx.people.keys()]).toEqual(["u1"]);
    expect(ctx.handles.has("sam")).toBe(false);
    const ranked = mergeMentionSuggestions([person("u2", "Sam", "sam"), person("u1", "Uma", "uma"), person("me", "Me", "me")], [], new Map(), Infinity, "", false, ctx);
    expect(ranked[0].label).toBe("Uma");
    expect(mergeMentionSuggestions([channel("c9", "design", 50), channel("c8", "infra", 1)], [], new Map(), Infinity, "", false, ctx)[0].label).toBe("infra");
  });

  test("a session composer reads its loaded messages", () => {
    const ctx = mentionContextFor({ messages: { conv: [{ content: "working on pl-4" }, { content: { blocks: [] } }] } }, "conv");
    expect(ctx.tokens.has("pl-4")).toBe(true);
  });

  test("groups keep ranked order, and the flattened order is what the popup walks", () => {
    const items = [
      { ...task("ct-1", "A"), contextAt: 3 }, person("u1", "Maya", "maya"), session("jx7aaaa", "S"), { ...person("u2", "Sam", "sam"), contextAt: 1 }, person("u3", "Zed", "zed"),
    ];
    const groups = groupMentionItems(items, "In this thread");
    expect(groups.map((g) => g.title)).toEqual(["In this thread", "People", "Sessions"]);
    expect(orderMentionItems(items).map((m) => m.label)).toEqual(["A", "Sam", "Maya", "Zed", "S"]);
  });
});
