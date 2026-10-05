// teamVisibleMedia (changes-page.md 8.4): a story shows a session's
// screenshots and instruction edits only when the team sees that session in
// full, and only what the session made around the story's commits.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { teamVisibleMedia } from "./changesAccess";
import { sessionArtifacts } from "./sessionMedia";

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
  test("a wordless capture takes the agent's next words and its command; a pasted image says a person pasted it", async () => {
    const t = convexTest(schema, modules);
    const conv = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Ana" } as any);
      const team = await ctx.db.insert("teams", { name: "Acme", created_at: 0, invite_code: "acme" } as any);
      const conv = await ctx.db.insert("conversations", { user_id: user, team_id: team, agent_type: "claude_code", session_id: "s", started_at: T, updated_at: T, message_count: 4, status: "active" } as any);
      const msg = (uuid: string, role: string, at: number, fields: Record<string, unknown>) => ctx.db.insert("messages", { conversation_id: conv, message_uuid: uuid, role, timestamp: at, ...fields } as any);
      await msg("call", "assistant", T + 5, { content: "", tool_calls: [{ id: "tu1", name: "Bash", input: "cast browser shot https://example.app/pricing" }] });
      const shot = await msg("result", "user", T + 6, { content: "", tool_results: [{ tool_use_id: "tu1", content: "" }], images: [{ media_type: "image/png", tool_use_id: "tu1" }] });
      await msg("said", "assistant", T + 8, { content: "The pricing card now shows its own title." });
      const pasted = await msg("ask", "user", T + 2, { content: "the card is wrong ![x](https://convex.example/bug.png)", images: [{ media_type: "image/png" }] });
      await ctx.db.insert("conversation_images", { conversation_id: conv, image_key: "shot", src: "https://convex.example/shot.png", message_id: shot, seq: 0, timestamp: T + 6 });
      await ctx.db.insert("conversation_images", { conversation_id: conv, image_key: "bug", src: "https://convex.example/bug.png", message_id: pasted, seq: 0, timestamp: T + 2 });
      return conv;
    });
    const media: Record<string, any> = await t.run(async (ctx) => Object.fromEntries(await teamVisibleMedia(ctx as any, [{ conversation_id: conv, mode: "full" }], { since: T, until: T + 1000 })));
    const byUrl = Object.fromEntries(media[String(conv)].images.map((i: any) => [i.url, i]));
    expect(byUrl["https://convex.example/shot.png"]).toMatchObject({
      origin: "captured during the work",
      context: "The pricing card now shows its own title. (taken with: cast browser shot https://example.app/pricing)",
    });
    expect(byUrl["https://convex.example/bug.png"]).toMatchObject({ origin: "pasted by a person", context: "the card is wrong" });
  });

  test("only a session seen in full lends its screenshots and instruction edits, from the story's window", async () => {
    const { t, ids } = await seed();
    const media: Record<string, any> = await t.run(async (ctx) => Object.fromEntries(await teamVisibleMedia(ctx as any, [
      { conversation_id: ids.full, mode: "full" },
      { conversation_id: ids.summary, mode: "summary" },
    ], { since: T, until: T + 1000 })));
    expect(Object.keys(media)).toEqual([String(ids.full)]);
    const full = media[String(ids.full)];
    expect(full.images).toEqual([{ url: "https://convex.example/full.png", timestamp: T + 10, context: "The new call card, after the fix", origin: "captured during the work" }]);
    expect(full.edits).toEqual([{ path: "packages/x/prompts/story.md", before: "Be brief.", after: "Write a short article.", timestamp: T + 20 }]);
  });
});

describe("sessionArtifacts", () => {
  test("a session's canvases and published pages in the window, titled, each once", async () => {
    const t = convexTest(schema, modules);
    const out = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Ana" } as any);
      const conv = await ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", session_id: "s", started_at: T, updated_at: T, message_count: 2, status: "active" } as any);
      const canvas = "```cast-canvas\n<div data-canvas-title=\"Refund flow, before and after\">...</div>\n```";
      await ctx.db.insert("messages", { conversation_id: conv, message_uuid: "a", role: "assistant", content: `Here it is:\n\n${canvas}\n\nThe eval report https://codecast.sh/a/refund-evals`, timestamp: T + 10 } as any);
      await ctx.db.insert("messages", { conversation_id: conv, message_uuid: "b", role: "assistant", content: "Again: https://codecast.sh/a/refund-evals", timestamp: T + 20 } as any);
      await ctx.db.insert("messages", { conversation_id: conv, message_uuid: "c", role: "user", content: "https://codecast.sh/a/from-the-human", timestamp: T + 30 } as any);
      return sessionArtifacts(ctx, conv, { since: T, until: T + 1000, max: 5 });
    });
    expect(out.map((a) => [a.kind, a.title])).toEqual([["page", "Again:"], ["canvas", "Refund flow, before and after"]]);
    expect(out[0]).toMatchObject({ url: "https://codecast.sh/a/refund-evals" });
  });
});

