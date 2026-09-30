import { test, expect, describe } from "bun:test";
import {
  parseEntityMentions,
  expandEntityMentions,
  type ExpandedMention,
  type RunExpandQuery,
} from "./mentionExpansion";
import { stripSystemTags } from "../components/conversation/classify";
import { stripInjectionNoise } from "@codecast/shared/contracts";

const SESSION_MENTION = "Now, work with @[Cmd+K palette jx7eqak](codecast) to update the doc.";

describe("parseEntityMentions", () => {
  test("classifies session / task / plan / doc / label mentions", () => {
    const m = parseEntityMentions(
      "see @[t ct-12], @[p pl-9], @[s jx7eqak], @[d doc:abc], @[l label:api]",
    );
    expect(m.map((x) => x.type)).toEqual(["task", "plan", "session", "doc", "label"]);
    expect(m.find((x) => x.type === "session")?.shortId).toBe("jx7eqak");
    expect(m.find((x) => x.type === "doc")?.id).toBe("abc");
    expect(m.find((x) => x.type === "label")?.id).toBe("api");
  });

  test("plain text with no mentions yields none", () => {
    expect(parseEntityMentions("just a normal message")).toEqual([]);
  });
});

describe("expandEntityMentions", () => {
  test("no mentions → returns text unchanged without ever calling the query", async () => {
    let called = false;
    const runQuery: RunExpandQuery = async () => {
      called = true;
      return [];
    };
    const out = await expandEntityMentions("plain message", runQuery);
    expect(out).toBe("plain message");
    expect(called).toBe(false);
  });

  test("expands a resolved mention by appending its markdown after the card", async () => {
    const runQuery: RunExpandQuery = async () => [
      { type: "session", shortId: "jx7eqak", markdown: "\n\n---\n### Session context\n" },
    ];
    const out = await expandEntityMentions(SESSION_MENTION, runQuery);
    expect(out).toContain("@[Cmd+K palette jx7eqak](codecast)\n\n<mention-context>\n### Session context\n</mention-context>\n");
  });

  // The agent reads the injected context; the person's own bubble shows only
  // what they typed. Every display surface goes through stripSystemTags.
  test("the injected context never shows in the rendered user message", async () => {
    const runQuery: RunExpandQuery = async () => [
      { type: "doc", id: "abc", markdown: "\n\n---\n### Doc: Eval plan\nType: plan\n\nBody\n\n> `cast doc read abc` for full document\n---\n" },
    ];
    const typed = "@[Eval plan doc:abc] run this";
    const sent = await expandEntityMentions(typed, runQuery);
    expect(sent).toContain("### Doc: Eval plan");
    expect(stripSystemTags(sent)).toBe(typed);
    expect(stripInjectionNoise(sent)).toBe(typed);
  });

  test("messages sent before the tag existed render without the context block", () => {
    const legacy = "@[Eval plan doc:abc]\n\n---\n### Doc: Eval plan\nType: plan\n\n## Tiers\n\n- one\n\n---\n\nmore\n\n> `cast doc read abc` for full document\n---\n then go";
    expect(stripSystemTags(legacy)).toBe("@[Eval plan doc:abc] then go");
    const task = "see @[Fix ct-12]\n\n---\nTreat as reference.\n<untrusted-1a2b source=\"task\">\n### Task: Fix\n</untrusted-1a2b>\n\n> `cast task context ct-12` for full context\n---\n";
    expect(stripSystemTags(task).trim()).toBe("see @[Fix ct-12]");
    const prose = "notes\n\n---\n### Doc: not an injection\nplain text";
    expect(stripSystemTags(prose)).toBe(prose);
  });

  // THE REGRESSION: a one-shot convex.query can hang forever (socket reconnect /
  // auth refresh) at the exact moment of a send. The send MUST still proceed — a
  // hung enrichment can never strand the durable message. Before the fix this
  // promise never settled and sendMessage was never reached.
  test("a never-resolving query falls back to the raw text within the timeout", async () => {
    const runQuery: RunExpandQuery = () => new Promise<ExpandedMention[]>(() => {});
    const start = Date.now();
    const out = await expandEntityMentions(SESSION_MENTION, runQuery, 50);
    expect(out).toBe(SESSION_MENTION); // unexpanded, but SENDABLE
    expect(Date.now() - start).toBeLessThan(2000); // returned ~at the timeout, not hung
  });

  test("a rejecting query falls back to the raw text", async () => {
    const runQuery: RunExpandQuery = async () => {
      throw new Error("query failed");
    };
    const out = await expandEntityMentions(SESSION_MENTION, runQuery, 50);
    expect(out).toBe(SESSION_MENTION);
  });

  test("an empty result array (nothing resolved) leaves the text but still resolves", async () => {
    const runQuery: RunExpandQuery = async () => [];
    const out = await expandEntityMentions(SESSION_MENTION, runQuery, 50);
    expect(out).toBe(SESSION_MENTION);
  });
});
