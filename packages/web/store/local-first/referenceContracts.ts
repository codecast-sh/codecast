import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { defineQueryView } from "./queryView";

type BucketRow = { _id: string; [key: string]: unknown };

/** Buckets + assignments are one query-owned projection, never fake canonical rows. */
export const bucketsPrincipalView = defineQueryView({
  id: "buckets.principal/v2",
  query: api.buckets.webListV2,
  key: (_args: Record<string, never>) => "buckets:principal",
  rows: (granted) => [
    ...granted.buckets.map((row: BucketRow) => ({ kind: "bucket" as const, row })),
    ...granted.assignments.map((row: BucketRow) => ({ kind: "assignment" as const, row })),
  ],
  entityKey: (row) => `${row.kind}:${row.row._id}`,
});

/** Conversation comments are a complete, demand-scoped projection-owned view. */
export const commentsByConversationView = defineQueryView({
  id: "comments.byConversation/v2",
  query: api.comments.getCommentsV2,
  key: ({ conversationId }: { conversationId: Id<"conversations"> }) =>
    `comments:conversation:${conversationId}`,
  queryArgs: ({ conversationId }) => ({ conversation_id: conversationId }),
  rows: (granted) => granted.comments,
  entityKey: (row) => `comment:${row._id}`,
});
