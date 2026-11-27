// Dictation: a person's speech streamed into a text box. The browser streams
// audio straight to OpenAI's realtime recognizer on a short-lived client
// secret minted here, closes its own turns, and writes the words into the box.
// Nothing about the audio or the words reaches this server.
//
// The switch is `users.dictation_enabled`, off until the person turns it on.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalQuery, mutation } from "./functions";
import { internal } from "./_generated/api";
import { asrTranscriptionSession, LIVE_TRANSCRIBE_MODEL, normalizeTranscribeLanguages } from "@codecast/shared/contracts";
import { workspaceKey } from "./lib/access";
import { requireUser } from "./lib/requireUser";
import { vendorRefusalFromDb } from "./lib/vendorGuard";
import { mintRealtimeSecret } from "./lib/realtimeMint";

type DictationGrant = { enabled: boolean; workspace: string; refusal: string | null };
type DictationToken = { client_secret: string; model: string; languages: string[] } | { error: string };

/** The Settings switch; each person sets only their own. */
export const setDictationEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ctx.db.patch(userId, { dictation_enabled: args.enabled });
  },
});

/** Whether the caller may dictate, and the workspace the mint answers to.
 *  A text box can belong to any of the person's teams (a task opened from a
 *  link, a comment in another team's channel), and the mint cannot tell which,
 *  so the audio is refused when ANY team they belong to may not send content
 *  to OpenAI. Null when signed out. */
export const authForDictation = internalQuery({
  args: {},
  handler: async (ctx): Promise<DictationGrant | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const workspaces = [
      ...memberships.map((m) => workspaceKey({ type: "team", teamId: m.team_id })),
      workspaceKey({ type: "personal", userId }),
    ];
    // Dictation streams the person's speech to OpenAI: a regulated team's only once it has a BAA.
    let refusal: string | null = null;
    for (const workspace of workspaces) {
      refusal = await vendorRefusalFromDb(ctx, { workspace }, "openai");
      if (refusal) break;
    }
    return { enabled: user.dictation_enabled === true, workspace: workspaces[workspaces.length - 1]!, refusal };
  },
});

/** A client secret for one dictation recognizer (the client-turn session),
 *  or the one line the mic shows when it may not have one. */
export const mintDictationToken = action({
  args: { languages: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<DictationToken> => {
    const grant: DictationGrant | null = await ctx.runQuery(internal.dictation.authForDictation, {});
    if (!grant) return { error: "Not signed in" };
    if (!grant.enabled) return { error: "Dictation is off" };
    if (grant.refusal) return { error: grant.refusal };
    if (!process.env.OPENAI_API_KEY) return { error: "Transcription is not configured" };
    const model = LIVE_TRANSCRIBE_MODEL;
    let languages = normalizeTranscribeLanguages(args.languages ?? []);
    let minted = await mintRealtimeSecret(ctx, grant.workspace, asrTranscriptionSession(model, languages), "dictation");
    // One unsupported language code rejects the whole session (a 400): retry
    // unconstrained. An outage or a quota error is not retried.
    if ("error" in minted && languages.length && minted.error.includes("(400)")) {
      languages = [];
      minted = await mintRealtimeSecret(ctx, grant.workspace, asrTranscriptionSession(model, languages), "dictation");
    }
    if ("error" in minted) return { error: minted.error };
    return { client_secret: minted.client_secret, model, languages };
  },
});
