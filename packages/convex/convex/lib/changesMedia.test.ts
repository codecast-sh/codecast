// teamVisibleMedia (changes-page.md 8.4): a story shows a session's
// screenshots and instruction edits only when the team sees that session in
// full, and only what the session made around the story's commits.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { teamVisibleMedia } from "./changesAccess";

const modules = { "../_generated/server.ts": () => import("../_generated/server") };
const T = 10_000_000;

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 0, invite_code: "acme" } as any);
    const made: Record<string, any> = { team };
    for (const name of ["full", "summary"]) {
      const conv = await ctx.db.insert("conversations", { user_id: user, team_id: team, agent_type: "claude_code", session_id: name, started_at: T, updated_at: T, message_count: 1, status: "active" } as any);
      const message = await ctx.db.insert("messages", { conversation_id: conv, message_uuid: `m-${name}`, role: "assistant", content: `The new call card, ![x](https://convex.example/${name}.png) after the fix`, timestamp: T + 10 } as any);
      await ctx.db.insert("conversation_images", { conversation_id: conv, image_key: `https://convex.example/${name}.png`, src: `https://convex.example/${name}.png`, message_id: message, seq: 0, timestamp: T + 10 });
      // An image long before the story's window is not its.
      await ctx.db.insert("conversation_images", { conversation_id: conv, image_key: `old-${name}`, src: `https://convex.example/old-${name}.png`, message_id: message, seq: 1, timestamp: T - 1_000_000 });
      await ctx.db.insert("file_changes", { conversation_id: conv, change_key: `k-${name}`, message_id: message, seq: 0, file_path: "packages/x/prompts/story.md", change_type: "edit", timestamp: T + 20 } as any);
      await ctx.db.insert("file_change_bodies", { conversation_id: conv, change_key: `k-${name}`, old_content: "Be brief.", new_content: "Write a short article." });
      made[name] = conv;
    }
    return made;
  });
  return { t, ids };
}

describe("teamVisibleMedia", () => {
  test("only a session seen in full lends its screenshots and instruction edits, from the story's window", async () => {
    const { t, ids } = await seed();
    const media: Record<string, any> = await t.run(async (ctx) => Object.fromEntries(await teamVisibleMedia(ctx as any, [
      { conversation_id: ids.full, mode: "full" },
      { conversation_id: ids.summary, mode: "summary" },
    ], { since: T, until: T + 1000 })));
    expect(Object.keys(media)).toEqual([String(ids.full)]);
    const full = media[String(ids.full)];
    expect(full.images).toEqual([{ url: "https://convex.example/full.png", timestamp: T + 10, context: "The new call card, after the fix" }]);
    expect(full.edits).toEqual([{ path: "packages/x/prompts/story.md", before: "Be brief.", after: "Write a short article.", timestamp: T + 20 }]);
  });
});
