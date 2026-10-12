// A prompt ablation over real stories, run where the model key lives: each
// arm rewrites the story request (text replacements, screenshots attached or
// not), and the reply is read by prod's parser. Internal and read-only; it
// writes nothing, and its spend is the caller's to budget.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { callModelMetered } from "./lib/anthropic";
import { parseStoryReply, storyImages, storyRequest } from "./changesProse";

export const mediaAblation = internalAction({
  args: {
    story_keys: v.array(v.string()),
    arms: v.array(v.object({ name: v.string(), replace: v.array(v.array(v.string())), images: v.boolean() })),
    reps: v.number(),
  },
  handler: async (ctx, args) => {
    const out: any[] = [];
    for (const key of args.story_keys) {
      const dump: any = await ctx.runQuery(internal.changesProse.storyInputAudit, { story_key: key });
      if (!dump) continue;
      const base = storyRequest(dump.input);
      await Promise.all(args.arms.flatMap((arm) => Array.from({ length: args.reps }, async (_, rep) => {
        let prompt = base.prompt;
        for (const [from, to] of arm.replace) {
          if (!prompt.includes(from)) throw new Error(`arm ${arm.name}: text not found: ${from.slice(0, 60)}`);
          prompt = prompt.replace(from, to);
        }
        const { reply, usage } = await callModelMetered({ ...base, prompt, images: arm.images ? storyImages(dump.input) : undefined, label: "Changes ablation", timeout_ms: 180_000 });
        const prose = reply ? parseStoryReply(reply.text, dump.input, { kind: "feature", importance: 2 }) : null;
        const body = prose?.body ?? "";
        out.push({
          story: key, arm: arm.name, rep,
          offered_img: dump.input.images.length, offered_emb: dump.input.embeds.length,
          placed_img: (body.match(/!\[/g) ?? []).length,
          placed_emb: (body.match(/```cast-canvas|codecast\.sh\/a\//g) ?? []).length,
          ok: !!prose, input_tokens: usage?.input_tokens ?? 0, body,
        });
      })));
    }
    return out;
  },
});
