// getConversationMeta (OG unfurl) and getConversationMention had NO access
// gate: any caller — an unauthenticated social bot included — got the title,
// first user message (200 chars), author, and idle_summary/model/status/
// project_path for ANY conversation, private ones included. The unfurl must
// reveal a session only when it is genuinely shared (share_token) or the caller
// truly has access; a private session reveals nothing.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getConversationMeta, getConversationMention } from "./conversations";

const OWNER = "u_owner";
const STRANGER = "u_stranger";

function tables(convExtra: Record<string, any> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Owner" },
      { _id: STRANGER, name: "Stranger" },
    ],
    conversations: [
      {
        _id: "conv",
        user_id: OWNER,
        is_private: true,
        title: "Secret refactor",
        idle_summary: "leaking secrets",
        model: "claude",
        status: "active",
        project_path: "/Users/owner/secret",
        message_count: 5,
        ...convExtra,
      },
    ],
    messages: [
      { _id: "m1", conversation_id: "conv", role: "user", content: "my secret prompt" },
    ],
  };
}

function ctx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
  } as any;
}

const meta = (uid: string | null, t: Record<string, any[]>, shareToken?: string) =>
  (getConversationMeta as any)._handler(ctx(uid, t), {
    conversation_id: "conv",
    ...(shareToken ? { share_token: shareToken } : {}),
  });
const mention = (uid: string | null, t: Record<string, any[]>) =>
  (getConversationMention as any)._handler(ctx(uid, t), { conversation_id: "conv" });

describe("getConversationMeta unfurl gate", () => {
  test("an anonymous bot gets NOTHING for a private session", async () => {
    expect(await meta(null, tables())).toBeNull();
  });

  test("an anonymous bot PRESENTING the share token gets meta", async () => {
    const r = await meta(null, tables({ share_token: "tok" }), "tok");
    expect(r?.title).toBe("Secret refactor");
  });

  test("issue #27: a bare conversation id unfurls NOTHING even when a share token exists", async () => {
    expect(await meta(null, tables({ share_token: "tok" }))).toBeNull();
  });

  test("presenting a wrong token unfurls nothing", async () => {
    expect(await meta(null, tables({ share_token: "tok" }), "guess")).toBeNull();
  });

  test("the owner always gets their own meta", async () => {
    const r = await meta(OWNER, tables());
    expect(r?.title).toBe("Secret refactor");
  });

  test("does not leak the full project_path field", async () => {
    const r = await meta(null, tables({ share_token: "tok" }), "tok");
    expect(r).not.toHaveProperty("project_path");
  });
});

// The description prefers idle_summary (the one-sentence card summary) over
// subtitle (a multi-bullet block); only subtitle's first bullet fits a link
// preview. Mirrors sessionCardSummary in packages/web/lib/sessionSummary.ts.
describe("getConversationMeta description derivation", () => {
  const desc = (convExtra: Record<string, any>) =>
    meta(OWNER, tables(convExtra)).then((r: any) => r?.description);

  test("idle_summary wins over subtitle", async () => {
    expect(await desc({ subtitle: "- first bullet\n- second bullet" }))
      .toBe("leaking secrets");
  });

  test("without idle_summary, only subtitle's first bullet survives, marker stripped", async () => {
    expect(await desc({ idle_summary: undefined, subtitle: "- first bullet\n- second bullet" }))
      .toBe("first bullet");
  });

  test("indented bullets and blank leading lines are handled", async () => {
    expect(await desc({ idle_summary: undefined, subtitle: "\n  - indented bullet\n- second" }))
      .toBe("indented bullet");
  });

  test("a bold opener is not mangled by the marker strip", async () => {
    expect(await desc({ idle_summary: undefined, subtitle: "**Bold heading**\n- bullet" }))
      .toBe("**Bold heading**");
  });

  test("whitespace-only idle_summary falls through to subtitle", async () => {
    expect(await desc({ idle_summary: "   ", subtitle: "- real summary" }))
      .toBe("real summary");
  });

  test("with neither, falls back to the first user message", async () => {
    expect(await desc({ idle_summary: undefined })).toBe("my secret prompt");
  });
});

describe("getConversationMention gate", () => {
  test("a stranger gets nothing for a private session", async () => {
    expect(await mention(STRANGER, tables())).toBeNull();
  });

  test("the owner gets the mention pill data", async () => {
    const r = await mention(OWNER, tables());
    expect(r?.idle_summary).toBe("leaking secrets");
  });
});
