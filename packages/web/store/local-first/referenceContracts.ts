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

// ── v3: stamped-log-ts coverage ─────────────────────────────────────────────
// Same server queries, same view keys, deeper coverage: the version is the
// backend log timestamp stamped from the delivering transition (covers joins
// and access inputs by construction), and write reconciliation uses the
// caller's command ids echoed inside the same query snapshot. First claim
// migrates the durable view from the v2 contract (fresh bootstrap).

export const bucketsPrincipalViewV3 = defineQueryView({
  id: "buckets.principal/v3",
  supersedes: "buckets.principal/v2",
  envelopeContractId: "buckets.principal/v2",
  coverageSource: "stamped-log-ts",
  query: api.buckets.webListV2,
  key: (_args: Record<string, never>) => "buckets:principal",
  rows: (granted) => [
    ...granted.buckets.map((row: BucketRow) => ({ kind: "bucket" as const, row })),
    ...granted.assignments.map((row: BucketRow) => ({ kind: "assignment" as const, row })),
  ],
  entityKey: (row) => `${row.kind}:${row.row._id}`,
});

export const commentsByConversationViewV3 = defineQueryView({
  id: "comments.byConversation/v3",
  supersedes: "comments.byConversation/v2",
  envelopeContractId: "comments.byConversation/v2",
  coverageSource: "stamped-log-ts",
  query: api.comments.getCommentsV2,
  key: ({ conversationId }: { conversationId: Id<"conversations"> }) =>
    `comments:conversation:${conversationId}`,
  queryArgs: ({ conversationId }) => ({ conversation_id: conversationId }),
  rows: (granted) => granted.comments,
  entityKey: (row) => `comment:${row._id}`,
});
