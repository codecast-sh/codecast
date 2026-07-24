import {
  defineCompleteView,
  type CompleteViewContractResult,
} from "./contracts";

type ProjectionDoc = { _id: string; [key: string]: unknown };

export type BucketsV2Result =
  | {
      contractId: "buckets.principal/v2";
      viewKey: "buckets:principal";
      access: "unauthenticated";
    }
  | {
      contractId: "buckets.principal/v2";
      viewKey: "buckets:principal";
      access: "granted";
      grantKeys: readonly string[];
      viewRevision: number;
      buckets: readonly ProjectionDoc[];
      assignments: readonly ProjectionDoc[];
    };

type BucketProjectionRow =
  | { kind: "bucket"; row: ProjectionDoc }
  | { kind: "assignment"; row: ProjectionDoc };

/** Buckets + assignments are one query-owned projection, never fake canonical rows. */
export const bucketsPrincipalView = defineCompleteView({
  id: "buckets.principal/v2",
  storage: "projection",
  key: (_args: Record<string, never>) => "buckets:principal",
  decode(result: BucketsV2Result): CompleteViewContractResult<BucketProjectionRow> {
    if (result.access === "unauthenticated") return result;
    return {
      contractId: result.contractId,
      viewKey: result.viewKey,
      access: "granted",
      grantKeys: result.grantKeys,
      coverage: {
        kind: "view-revision",
        revision: String(result.viewRevision),
        revisionOrder: result.viewRevision,
      },
      rows: [
        ...result.buckets.map((row) => ({ kind: "bucket" as const, row })),
        ...result.assignments.map((row) => ({ kind: "assignment" as const, row })),
      ],
    };
  },
  normalize(row: BucketProjectionRow, context) {
    return {
      entityKey: `${row.kind}:${row.row._id}`,
      grantKeys: context.grantKeys,
      projection: row,
    };
  },
});

export type CommentsV2Result =
  | {
      contractId: "comments.byConversation/v2";
      viewKey: string;
      access: "unauthenticated";
    }
  | {
      contractId: "comments.byConversation/v2";
      viewKey: string;
      access: "missing";
      releasedGrantKeys: readonly string[];
      removals: readonly [];
    }
  | {
      contractId: "comments.byConversation/v2";
      viewKey: string;
      access: "forbidden";
      revokedGrantKeys: readonly string[];
    }
  | {
      contractId: "comments.byConversation/v2";
      viewKey: string;
      access: "granted";
      grantKeys: readonly string[];
      viewRevision: number;
      coverage: {
        kind: "view-revision";
        revision: string;
        revisionOrder: number;
      };
      comments: readonly ProjectionDoc[];
    };

/** Conversation comments are a complete, demand-scoped projection-owned view. */
export const commentsByConversationView = defineCompleteView({
  id: "comments.byConversation/v2",
  storage: "projection",
  key: ({ conversationId }: { conversationId: string }) =>
    `comments:conversation:${conversationId}`,
  decode(result: CommentsV2Result): CompleteViewContractResult<ProjectionDoc> {
    if (result.access === "granted") {
      return {
        contractId: result.contractId,
        viewKey: result.viewKey,
        access: "granted",
        grantKeys: result.grantKeys,
        coverage: result.coverage,
        rows: result.comments,
      };
    }
    return result;
  },
  normalize(row: ProjectionDoc, context) {
    return {
      entityKey: `comment:${row._id}`,
      grantKeys: context.grantKeys,
      projection: row,
    };
  },
});
