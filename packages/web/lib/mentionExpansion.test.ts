import { test, expect, describe } from "bun:test";
import {
  parseEntityMentions,
  expandEntityMentions,
  type ExpandedMention,
  type RunExpandQuery,
} from "./mentionExpansion";

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
    expect(out).toContain("@[Cmd+K palette jx7eqak](codecast)\n\n---\n### Session context\n");
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
