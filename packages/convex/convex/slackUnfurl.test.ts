import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { cardFor, unfurlBlocks, type UnfurlCard } from "./slackUnfurl";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const EVE = "user-eve" as any;
const TEAM = "team-main" as any;
const SHARED = "jx7abcdefghijklmnopqrstuvwxyz012";
const PRIVATE = "jx7zzzzzzzzzzzzzzzzzzzzzzzzzz999";

function ctx() {
  const db = makeFakeDb({
    users: [
      { _id: ALICE, name: "Alice", image: "https://img.test/alice.png" },
      { _id: BOB, name: "Bob" },
      { _id: EVE, name: "Eve" },
    ],
    teams: [{ _id: TEAM, name: "Union", invite_code: "U", created_at: 1 }],
    team_memberships: [
      { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "admin" },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "member" },
    ],
    conversations: [
      {
        _id: SHARED, user_id: ALICE, team_id: TEAM, is_private: false, auto_shared: true,
        title: "Fix the Slack unfurls", message_count: 42, status: "active",
        project_path: "/Users/alice/dev/codecast", updated_at: 1_790_000_000_000,
        thread_state: "Rendering link cards in Slack\nStatus: tests green", thread_state_status: "working",
        idle_summary: "Older summary",
      },
      {
        _id: PRIVATE, user_id: ALICE, team_id: TEAM, is_private: true,
        title: "Secret", message_count: 3, status: "active", updated_at: 1,
      },
    ],
    tasks: [
      { _id: "tasks_1", user_id: ALICE, team_id: TEAM, workspace: `team:${TEAM}`, short_id: "ct-7", title: "Unfurl tasks", description: "Draw **task** cards", status: "in_progress", priority: "high", _creationTime: 5 },
      { _id: "tasks_2", user_id: ALICE, team_id: TEAM, workspace: `user:${ALICE}`, short_id: "ct-8", title: "Mine", status: "open", priority: "low", _creationTime: 5 },
    ],
    docs: [
      { _id: "docs_1", user_id: ALICE, team_id: TEAM, workspace: `team:${TEAM}`, title: "Design", content: "# Heading\nBody", doc_type: "note", updated_at: 9 },
    ],
    session_owners: [],
    share_redemptions: [],
  });
  return { db } as any;
}

const card = (viewer: any, url: string) => (cardFor as any)._handler(ctx(), { viewer, url });

describe("cardFor", () => {
  test("a teammate sees a team session: title, current state, facts, author", async () => {
    const c = await card(BOB, `https://codecast.sh/conversation/${SHARED}`);
    expect(c).toMatchObject({
      title: "Fix the Slack unfurls",
      summary: "Rendering link cards in Slack",
      facts: ["Working", "42 messages", "codecast"],
      author: { name: "Alice", avatar_url: "https://img.test/alice.png" },
    });
  });

  test("a private session unfurls for its owner and for nobody else", async () => {
    expect(await card(ALICE, `https://codecast.sh/conversation/${PRIVATE}`)).toMatchObject({ title: "Secret" });
    expect(await card(BOB, `https://codecast.sh/conversation/${PRIVATE}`)).toBeNull();
  });

  test("someone outside the team gets nothing", async () => {
    expect(await card(EVE, `https://codecast.sh/conversation/${SHARED}`)).toBeNull();
  });

  test("tasks and docs follow their workspace key", async () => {
    expect(await card(BOB, "https://codecast.sh/tasks/ct-7")).toMatchObject({
      title: "ct-7 · Unfurl tasks", summary: "Draw task cards", facts: ["in progress", "high priority"],
    });
    expect(await card(BOB, "https://codecast.sh/tasks/ct-8")).toBeNull();
    expect(await card(ALICE, "https://codecast.sh/tasks/ct-8")).toMatchObject({ title: "ct-8 · Mine" });
    expect(await card(BOB, "https://codecast.sh/docs/docs_1")).toMatchObject({ title: "Design", facts: ["note"] });
    expect(await card(EVE, "https://codecast.sh/docs/docs_1")).toBeNull();
  });

  test("share links and non-entity URLs are left to the ordinary unfurl", async () => {
    expect(await card(ALICE, `https://codecast.sh/conversation/${SHARED}?share=tok`)).toBeNull();
    expect(await card(ALICE, "https://codecast.sh/share/abc123")).toBeNull();
    expect(await card(ALICE, "https://example.com/conversation/x")).toBeNull();
  });
});

describe("unfurlBlocks", () => {
  const base: UnfurlCard = {
    title: "Ship <it> & go",
    url: "https://codecast.sh/conversation/x",
    summary: "Line one",
    facts: ["Working", "3 messages"],
    author: { name: "Alice", avatar_url: "https://img.test/a.png" },
    updated_at: 1_790_000_000_000,
  };

  test("links the escaped title, puts the summary under it, and a context line with the face", () => {
    const [section, context] = unfurlBlocks(base) as any[];
    expect(section.text.text).toBe("*<https://codecast.sh/conversation/x|Ship &lt;it&gt; &amp; go>*\nLine one");
    expect(context.elements[0]).toEqual({ type: "image", image_url: "https://img.test/a.png", alt_text: "Alice" });
    expect(context.elements[1].text).toStartWith("Alice  ·  Working  ·  3 messages  ·  <!date^1790000000^updated {ago}|");
  });

  test("no summary and no avatar still draws a valid card", () => {
    const blocks = unfurlBlocks({ ...base, summary: null, author: { name: "Bob", avatar_url: null } }) as any[];
    expect(blocks[0].text.text).not.toContain("\n");
    expect(blocks[1].elements).toHaveLength(1);
  });
});
