import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { canTeamMemberAccess } from "./privacy";

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const isVoyage = !!process.env.VOYAGE_API_KEY;

  try {
    if (isVoyage) {
      const response = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "voyage-3-lite",
          input: text,
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data?.[0]?.embedding || null;
    } else {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
          dimensions: 1024,
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data?.[0]?.embedding || null;
    }
  } catch {
    return null;
  }
}

export const setMessageEmbedding = internalMutation({
  args: {
    message_id: v.id("messages"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.message_id, { embedding: args.embedding });
  },
});

export const generateMessageEmbedding = internalAction({
  args: {
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const message = await ctx.runQuery(internal.embeddings.getMessage, {
      message_id: args.message_id,
    });

    if (!message || !message.content || message.content.length < 10) {
      return;
    }

    const text = message.content.slice(0, 8000);
    const embedding = await generateEmbedding(text);

    if (embedding) {
      await ctx.runMutation(internal.embeddings.setMessageEmbedding, {
        message_id: args.message_id,
        embedding,
      });
    }
  },
});

export const getMessage = internalQuery({
  args: {
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.message_id);
  },
});

export const getMessagesWithoutEmbeddings = internalQuery({
  args: {
    limit: v.number(),
    cursor: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("messages")
      .withIndex("by_timestamp")
      .order("desc");

    if (args.cursor) {
      const cursorDoc = await ctx.db.get(args.cursor);
      if (cursorDoc) {
        query = ctx.db
          .query("messages")
          .withIndex("by_timestamp", q => q.lt("timestamp", cursorDoc.timestamp))
          .order("desc");
      }
    }

    const messages = await query.take(args.limit * 2);

    const needsEmbedding = messages.filter(m =>
      !m.embedding &&
      m.content &&
      m.content.length >= 10 &&
      (m.role === "user" || m.role === "assistant") &&
      !m.tool_results?.length
    );

    return needsEmbedding.slice(0, args.limit);
  },
});

export const backfillEmbeddings = internalAction({
  args: {
    batch_size: v.optional(v.number()),
    max_batches: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{
    done: boolean;
    totalProcessed: number;
    batchesRun: number;
  }> => {
    const batchSize = args.batch_size || 20;
    const maxBatches = args.max_batches || 50;
    let totalProcessed = 0;
    let batchesRun = 0;

    for (let i = 0; i < maxBatches; i++) {
      const messages: Array<{ _id: Id<"messages"> }> = await ctx.runQuery(
        internal.embeddings.getMessagesWithoutEmbeddings,
        { limit: batchSize }
      );

      if (messages.length === 0) {
        console.log(`Backfill complete after ${batchesRun} batches, ${totalProcessed} messages embedded`);
        return { done: true, totalProcessed, batchesRun };
      }

      for (const message of messages) {
        try {
          await ctx.runAction(internal.embeddings.generateMessageEmbedding, {
            message_id: message._id,
          });
          totalProcessed++;
        } catch (e) {
          console.error(`Failed to embed message ${message._id}:`, e);
        }
      }

      batchesRun++;
      console.log(`Batch ${batchesRun}: embedded ${messages.length} messages (total: ${totalProcessed})`);
    }

    console.log(`Reached max batches (${maxBatches}), ${totalProcessed} messages embedded. Run again to continue.`);
    return { done: false, totalProcessed, batchesRun };
  },
});

export const semanticSearch = internalAction({
  args: {
    query: v.string(),
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Array<{
    message_id: Id<"messages">;
    conversation_id: Id<"conversations">;
    score: number;
    content: string;
  }>> => {
    const queryEmbedding = await generateEmbedding(args.query);
    if (!queryEmbedding) {
      return [];
    }

    const limit = args.limit || 20;

    const results = await ctx.vectorSearch("messages", "by_embedding", {
      vector: queryEmbedding,
      limit: limit * 2,
    });

    const enrichedResults = await ctx.runQuery(internal.embeddings.enrichSearchResults, {
      results: results.map(r => ({ id: r._id, score: r._score })),
      user_id: args.user_id,
    });

    return enrichedResults.slice(0, limit);
  },
});

export const enrichSearchResults = internalQuery({
  args: {
    results: v.array(v.object({
      id: v.id("messages"),
      score: v.number(),
    })),
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (!user) return [];

    const enriched: Array<{
      message_id: Id<"messages">;
      conversation_id: Id<"conversations">;
      score: number;
      content: string;
    }> = [];

    for (const result of args.results) {
      const message = await ctx.db.get(result.id);
      if (!message || !message.content) continue;

      const conversation = await ctx.db.get(message.conversation_id);
      if (!conversation) continue;

      const isOwner = conversation.user_id === args.user_id;
      if (!isOwner && !(await canTeamMemberAccess(ctx, args.user_id, conversation))) continue;

      enriched.push({
        message_id: message._id,
        conversation_id: message.conversation_id,
        score: result.score,
        content: message.content,
      });
    }

    return enriched;
  },
});
