import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { type Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { enqueuePendingMessage } from "./pendingMessages";
import {
  canAccessConversation,
  canAccessPullRequest,
} from "./lib/access";
import { requireUser } from "./lib/auth";
import {
  readLocalViewRevision,
  runLocalCommand,
} from "./localFirstCommands";
import {
  COMMENTS_VIEW_CONTRACT_ID,
  commentsCoverageTarget,
  commentsGrantKey,
  commentsViewKey,
  deleteCommentWithRevision,
  patchCommentWithRevision,
  runCommentViewTransition,
} from "./commentViewWrites";

export {
  COMMENTS_VIEW_CONTRACT_ID,
  commentsGrantKey,
  commentsViewKey,
} from "./commentViewWrites";

type CommentReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

type CommentFailure = {
  status: "rejected";
  code: string;
  message: string;
  correction?: unknown;
};

type Validation<T> = { ok: true; value: T } | { ok: false; failure: CommentFailure };

function missingConversation(conversationId: Id<"conversations">): CommentFailure {
  return {
    status: "rejected",
    code: "MISSING",
    message: "Conversation not found",
    correction: {
      releasedGrantKeys: [commentsGrantKey(conversationId)],
      removals: [],
    },
  };
}

function forbiddenConversation(conversationId: Id<"conversations">): CommentFailure {
  return {
    status: "rejected",
    code: "FORBIDDEN",
    message: "Conversation access was revoked",
    correction: { revokedGrantKeys: [commentsGrantKey(conversationId)] },
  };
}

async function validateConversationAccess(
  ctx: CommentReadCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<Validation<Doc<"conversations">>> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return { ok: false, failure: missingConversation(conversationId) };
  if (!(await canAccessConversation(ctx, userId, conversation))) {
    return { ok: false, failure: forbiddenConversation(conversationId) };
  }
  return { ok: true, value: conversation };
}

type CreateCommentArgs = {
  conversation_id: Id<"conversations">;
  message_id?: Id<"messages">;
  content: string;
  parent_comment_id?: Id<"comments">;
  pr_id?: Id<"pull_requests">;
  file_path?: string;
  line_number?: number;
  client_id?: string;
};

type ValidatedCreate = {
  conversation: Doc<"conversations">;
  message?: Doc<"messages">;
  parent?: Doc<"comments">;
  pullRequest?: Doc<"pull_requests">;
};

async function validateCreateComment(
  ctx: CommentReadCtx,
  userId: Id<"users">,
  args: CreateCommentArgs,
): Promise<Validation<ValidatedCreate>> {
  const access = await validateConversationAccess(ctx, userId, args.conversation_id);
  if (!access.ok) return access;

  let message: Doc<"messages"> | undefined;
  if (args.message_id) {
    const candidate = await ctx.db.get(args.message_id);
    if (!candidate || String(candidate.conversation_id) !== String(args.conversation_id)) {
      return {
        ok: false,
        failure: {
          status: "rejected",
          code: "INVALID_RELATION",
          message: "Comment message does not belong to the conversation",
        },
      };
    }
    message = candidate;
  }

  let parent: Doc<"comments"> | undefined;
  if (args.parent_comment_id) {
    const candidate = await ctx.db.get(args.parent_comment_id);
    if (!candidate || String(candidate.conversation_id) !== String(args.conversation_id)) {
      return {
        ok: false,
        failure: {
          status: "rejected",
          code: "INVALID_RELATION",
          message: "Parent comment does not belong to the conversation",
        },
      };
    }
    parent = candidate;
  }

  let pullRequest: Doc<"pull_requests"> | undefined;
  if (args.pr_id) {
    const candidate = await ctx.db.get(args.pr_id);
    if (!candidate || !(await canAccessPullRequest(ctx, userId, candidate))) {
      return {
        ok: false,
        failure: { status: "rejected", code: "NOT_FOUND", message: "Pull request not found" },
      };
    }
    if (!candidate.linked_session_ids.some((id) => String(id) === String(args.conversation_id))) {
      return {
        ok: false,
        failure: {
          status: "rejected",
          code: "INVALID_RELATION",
          message: "Pull request is not linked to the conversation",
        },
      };
    }
    pullRequest = candidate;
  }

  return {
    ok: true,
    value: { conversation: access.value, message, parent, pullRequest },
  };
}

function throwLegacyCommentFailure(failure: CommentFailure): never {
  if (failure.code === "FORBIDDEN") {
    throw new Error("Unauthorized: not allowed to comment on this conversation");
  }
  throw new Error(failure.message);
}

async function findCommentByClientId(
  ctx: CommentReadCtx,
  conversationId: Id<"conversations">,
  clientId: string,
): Promise<Doc<"comments"> | null> {
  return await ctx.db
    .query("comments")
    .withIndex("by_conversation_client_id", (q: any) =>
      q.eq("conversation_id", conversationId).eq("client_id", clientId))
    .first();
}

function sameOptionalId(left: unknown, right: unknown): boolean {
  return left === undefined && right === undefined
    || left !== undefined && right !== undefined && String(left) === String(right);
}

function existingCreateMatches(
  comment: Doc<"comments">,
  userId: Id<"users">,
  args: CreateCommentArgs,
): boolean {
  return String(comment.user_id) === String(userId)
    && comment.content === args.content
    && sameOptionalId(comment.message_id, args.message_id)
    && sameOptionalId(comment.parent_comment_id, args.parent_comment_id)
    && sameOptionalId(comment.pr_id, args.pr_id)
    && comment.file_path === args.file_path
    && comment.line_number === args.line_number;
}

async function projectComments(
  ctx: CommentReadCtx,
  comments: Doc<"comments">[],
) {
  const projected = await Promise.all(comments.map(async (comment) => {
    const user = await ctx.db.get(comment.user_id);
    return {
      ...comment,
      user: {
        _id: user?._id,
        name: user?.name,
        image: user?.image,
        github_username: user?.github_username,
        github_avatar_url: user?.github_avatar_url,
      },
    };
  }));
  return projected.sort((left, right) =>
    left.created_at - right.created_at || String(left._id).localeCompare(String(right._id)));
}

/** Complete projection for one exact conversation comment view. */
export const getCommentsV2 = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const contractId = COMMENTS_VIEW_CONTRACT_ID;
    const viewKey = commentsViewKey(args.conversation_id);
    const grantKey = commentsGrantKey(args.conversation_id);
    const userId = await getAuthUserId(ctx);
    if (!userId) return { contractId, viewKey, access: "unauthenticated" as const };

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return {
        contractId,
        viewKey,
        access: "missing" as const,
        releasedGrantKeys: [grantKey],
        removals: [],
      };
    }
    if (!(await canAccessConversation(ctx, userId, conversation))) {
      return {
        contractId,
        viewKey,
        access: "forbidden" as const,
        revokedGrantKeys: [grantKey],
      };
    }

    const [comments, viewRevision] = await Promise.all([
      ctx.db
        .query("comments")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .collect(),
      readLocalViewRevision(
        ctx,
        conversation.user_id,
        COMMENTS_VIEW_CONTRACT_ID,
        viewKey,
      ),
    ]);
    return {
      contractId,
      viewKey,
      access: "granted" as const,
      grantKeys: [grantKey],
      viewRevision,
      coverage: {
        kind: "view-revision" as const,
        revision: String(viewRevision),
        revisionOrder: viewRevision,
      },
      comments: await projectComments(ctx, comments),
    };
  },
});

type CommentRevisionMode = "advance" | "receipt";

function requiredClientIdFailure(): CommentFailure {
  return {
    status: "rejected",
    code: "INVALID_ARGUMENT",
    message: "client_id must be a non-empty canonical string",
  };
}

type CreateCommentExecution =
  | { ok: true; commentId: Id<"comments">; coverageTarget?: ReturnType<typeof commentsCoverageTarget> }
  | { ok: false; failure: CommentFailure };

async function executeCreateComment(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: CreateCommentArgs,
  validated: ValidatedCreate,
  revisionMode: CommentRevisionMode,
): Promise<CreateCommentExecution> {
  if (args.client_id) {
    const duplicate = await findCommentByClientId(ctx, args.conversation_id, args.client_id);
    if (duplicate) {
      if (!existingCreateMatches(duplicate, userId, args)) {
        return {
          ok: false,
          failure: {
            status: "rejected",
            code: "CLIENT_ID_REUSED",
            message: "This client id is already bound to different comment intent",
          },
        };
      }
      return {
        ok: true,
        commentId: duplicate._id,
        // A new command id still needs positive coverage so its local overlay
        // can settle, even though client-id idempotency found the row already.
        coverageTarget: revisionMode === "receipt"
          ? commentsCoverageTarget(validated.conversation)
          : undefined,
      };
    }
  }

  const transition = await runCommentViewTransition(
    ctx,
    validated.conversation,
    revisionMode,
    async (writer) => await writer.insert({
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      user_id: userId,
      content: args.content,
      parent_comment_id: args.parent_comment_id,
      created_at: Date.now(),
      pr_id: args.pr_id,
      file_path: args.file_path,
      line_number: args.line_number,
      client_id: args.client_id,
    }),
  );
  const commentId = transition.result;

  const actor = await ctx.db.get(userId);
  const actorName = actor?.name || actor?.github_username || actor?.email || "Someone";
  const notified = new Set<string>();

  await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
    user_id: userId,
    entity_type: "conversation",
    entity_id: args.conversation_id.toString(),
    reason: "commenter",
  });

  const mentions = Array.from(args.content.matchAll(/@(\w+)/g)).map((match) => match[1]);
  if (validated.conversation.team_id && mentions.length > 0) {
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", validated.conversation.team_id))
      .collect();
    const teamMembers: Array<Doc<"users"> | null> = await Promise.all(
      memberships.map((membership: { user_id: Id<"users"> }) =>
        ctx.db.get(membership.user_id)),
    );
    const validMembers = teamMembers.filter((user): user is Doc<"users"> => user !== null);
    for (const mention of mentions) {
      const mentionedUser = validMembers.find((user) =>
        user.github_username === mention || user.name === mention);
      if (mentionedUser && String(mentionedUser._id) !== String(userId)) {
        await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
          user_id: mentionedUser._id,
          entity_type: "conversation",
          entity_id: args.conversation_id.toString(),
          reason: "mentioned",
        });
        await ctx.runMutation(internal.notificationRouter.emit, {
          event_type: "mention",
          actor_user_id: userId,
          entity_type: "conversation",
          entity_id: args.conversation_id.toString(),
          message: `${actorName} mentioned you in a comment`,
          conversation_id: args.conversation_id,
          comment_id: commentId,
          direct_recipient_id: mentionedUser._id,
        });
        notified.add(String(mentionedUser._id));
      }
    }
  }

  const parentAuthor = validated.parent?.user_id?.toString();
  if (
    validated.parent
    && parentAuthor
    && parentAuthor !== String(userId)
    && !notified.has(parentAuthor)
  ) {
    await ctx.runMutation(internal.notificationRouter.emit, {
      event_type: "comment_reply",
      actor_user_id: userId,
      entity_type: "conversation",
      entity_id: args.conversation_id.toString(),
      message: `${actorName} replied to your comment`,
      conversation_id: args.conversation_id,
      comment_id: commentId,
      direct_recipient_id: validated.parent.user_id,
    });
    notified.add(parentAuthor);
  }

  const ownerId = validated.conversation.user_id.toString();
  if (ownerId !== String(userId) && !notified.has(ownerId)) {
    await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
      user_id: validated.conversation.user_id,
      entity_type: "conversation",
      entity_id: args.conversation_id.toString(),
      reason: "watching",
    });
    await ctx.runMutation(internal.notificationRouter.emit, {
      event_type: "conversation_comment",
      actor_user_id: userId,
      entity_type: "conversation",
      entity_id: args.conversation_id.toString(),
      message: `${actorName} commented on your conversation`,
      conversation_id: args.conversation_id,
      comment_id: commentId,
      direct_recipient_id: validated.conversation.user_id,
    });
  }

  let pullRequest = validated.pullRequest;
  if (!pullRequest) {
    const candidates = await ctx.db.query("pull_requests").collect();
    for (const candidate of candidates) {
      if (
        candidate.linked_session_ids.some((id) => String(id) === String(args.conversation_id))
        && (await canAccessPullRequest(ctx, userId, candidate))
      ) {
        pullRequest = candidate;
        break;
      }
    }
  }
  const githubUser = pullRequest ? await ctx.db.get(userId) : null;
  if (pullRequest && githubUser?.github_access_token) {
    await ctx.scheduler.runAfter(0, internal.githubApi.postCommentToGitHub, {
      repository: pullRequest.repository,
      pr_number: pullRequest.number,
      content: args.content,
      file_path: args.file_path,
      line_number: args.line_number,
      github_access_token: githubUser.github_access_token,
      comment_id: commentId,
    });
  }

  return { ok: true, commentId, coverageTarget: transition.coverageTarget };
}

const createCommentValidators = {
  conversation_id: v.id("conversations"),
  message_id: v.optional(v.id("messages")),
  content: v.string(),
  parent_comment_id: v.optional(v.id("comments")),
  pr_id: v.optional(v.id("pull_requests")),
  file_path: v.optional(v.string()),
  line_number: v.optional(v.number()),
  client_id: v.optional(v.string()),
};

export const addComment = mutation({
  args: createCommentValidators,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const validated = await validateCreateComment(ctx, userId, args);
    if (!validated.ok) throwLegacyCommentFailure(validated.failure);
    const executed = await executeCreateComment(ctx, userId, args, validated.value, "advance");
    if (!executed.ok) throw new Error(executed.failure.message);
    return executed.commentId;
  },
});

export const addCommentV2 = mutation({
  args: { command_id: v.string(), ...createCommentValidators, client_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "comments.create/v2",
      arguments: {
        conversationId: args.conversation_id,
        messageId: args.message_id,
        content: args.content,
        parentCommentId: args.parent_comment_id,
        pullRequestId: args.pr_id,
        filePath: args.file_path,
        lineNumber: args.line_number,
        clientId: args.client_id,
      },
    }, async () => {
      if (!args.client_id.trim()) return requiredClientIdFailure();
      const validated = await validateCreateComment(ctx, userId, args);
      if (!validated.ok) return validated.failure;
      const executed = await executeCreateComment(ctx, userId, args, validated.value, "receipt");
      if (!executed.ok) return executed.failure;
      return {
        status: "acknowledged" as const,
        result: { commentId: executed.commentId, clientId: args.client_id },
        coverageViews: executed.coverageTarget ? [executed.coverageTarget] : [],
      };
    });
  },
});

export const getComments = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return [];
    }

    if (!(await canAccessConversation(ctx, userId, conversation))) return [];

    let comments;
    if (args.message_id) {
      const message = await ctx.db.get(args.message_id);
      if (!message || String(message.conversation_id) !== String(args.conversation_id)) return [];
      comments = await ctx.db
        .query("comments")
        .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
        .collect();
    } else {
      comments = await ctx.db
        .query("comments")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .filter((q) => q.eq(q.field("message_id"), undefined))
        .collect();
    }

    const commentsWithUsers = await Promise.all(
      comments.map(async (comment) => {
        const user = await ctx.db.get(comment.user_id);
        return {
          ...comment,
          user: {
            _id: user?._id,
            name: user?.name,
            image: user?.image,
            github_username: user?.github_username,
            github_avatar_url: user?.github_avatar_url,
          },
        };
      })
    );

    return commentsWithUsers.sort((a, b) => a.created_at - b.created_at);
  },
});

export const getCommentCount = query({
  args: {
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) return 0;
    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return 0;

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .collect();

    return comments.length;
  },
});

type CommentReferenceArgs = {
  conversation_id: Id<"conversations">;
  comment_id?: Id<"comments">;
  client_id?: string;
};

type ValidatedOwnedComment = {
  conversation: Doc<"conversations">;
  comment: Doc<"comments">;
};

async function validateOwnedComment(
  ctx: CommentReadCtx,
  userId: Id<"users">,
  args: CommentReferenceArgs,
): Promise<Validation<ValidatedOwnedComment>> {
  const access = await validateConversationAccess(ctx, userId, args.conversation_id);
  if (!access.ok) return access;
  if (!args.comment_id && !args.client_id?.trim()) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "INVALID_ARGUMENT",
        message: "comment_id or client_id is required",
      },
    };
  }

  let comment = args.comment_id ? await ctx.db.get(args.comment_id) : null;
  if (!comment && args.client_id) {
    comment = await findCommentByClientId(ctx, args.conversation_id, args.client_id);
  }
  if (!comment) {
    return {
      ok: false,
      failure: { status: "rejected", code: "NOT_FOUND", message: "Comment not found" },
    };
  }
  if (String(comment.conversation_id) !== String(args.conversation_id)) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "INVALID_RELATION",
        message: "Comment does not belong to the conversation",
      },
    };
  }
  if (args.client_id && comment.client_id !== args.client_id) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "INVALID_RELATION",
        message: "Comment id and client id identify different comments",
      },
    };
  }
  if (String(comment.user_id) !== String(userId)) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "FORBIDDEN",
        message: "Only the comment author may change it",
      },
    };
  }
  return { ok: true, value: { conversation: access.value, comment } };
}

export const updateComment = mutation({
  args: {
    comment_id: v.id("comments"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const comment = await ctx.db.get(args.comment_id);
    if (!comment) {
      throw new Error("Comment not found");
    }

    if (comment.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: can only edit your own comments");
    }
    const conversation = await ctx.db.get(comment.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
      throw new Error("Unauthorized: conversation access revoked");
    }

    await patchCommentWithRevision(ctx, comment, { content: args.content }, conversation);

    return args.comment_id;
  },
});

export const deleteComment = mutation({
  args: {
    comment_id: v.id("comments"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const comment = await ctx.db.get(args.comment_id);
    if (!comment) {
      throw new Error("Comment not found");
    }

    if (comment.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: can only delete your own comments");
    }
    const conversation = await ctx.db.get(comment.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
      throw new Error("Unauthorized: conversation access revoked");
    }

    await deleteCommentWithRevision(ctx, comment, conversation);

    return true;
  },
});

const commandCommentReferenceValidators = {
  conversation_id: v.id("conversations"),
  comment_id: v.optional(v.id("comments")),
  client_id: v.optional(v.string()),
};

export const updateCommentV2 = mutation({
  args: {
    command_id: v.string(),
    ...commandCommentReferenceValidators,
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "comments.update/v2",
      arguments: {
        conversationId: args.conversation_id,
        commentId: args.comment_id,
        clientId: args.client_id,
        content: args.content,
      },
    }, async () => {
      const validated = await validateOwnedComment(ctx, userId, args);
      if (!validated.ok) return validated.failure;
      if (validated.value.comment.content === args.content) {
        return {
          status: "acknowledged" as const,
          result: {
            commentId: validated.value.comment._id,
            clientId: validated.value.comment.client_id,
          },
          // Acknowledgement must carry positive coverage even when the
          // authoritative content already equals the optimistic intent.
          coverageViews: [commentsCoverageTarget(validated.value.conversation)],
        };
      }
      const transition = await runCommentViewTransition(
        ctx,
        validated.value.conversation,
        "receipt",
        async (writer) => {
          await writer.patch(validated.value.comment._id, { content: args.content });
        },
      );
      return {
        status: "acknowledged" as const,
        result: {
          commentId: validated.value.comment._id,
          clientId: validated.value.comment.client_id,
        },
        coverageViews: transition.coverageTarget ? [transition.coverageTarget] : [],
      };
    });
  },
});

export const deleteCommentV2 = mutation({
  args: { command_id: v.string(), ...commandCommentReferenceValidators },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "comments.delete/v2",
      arguments: {
        conversationId: args.conversation_id,
        commentId: args.comment_id,
        clientId: args.client_id,
      },
    }, async () => {
      const validated = await validateOwnedComment(ctx, userId, args);
      if (!validated.ok) return validated.failure;
      const transition = await runCommentViewTransition(
        ctx,
        validated.value.conversation,
        "receipt",
        async (writer) => await writer.delete(validated.value.comment._id),
      );
      return {
        status: "acknowledged" as const,
        result: {
          commentId: validated.value.comment._id,
          clientId: validated.value.comment.client_id,
        },
        coverageViews: transition.coverageTarget ? [transition.coverageTarget] : [],
      };
    });
  },
});

export const getConversationCommentSummary = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];

    if (!(await canAccessConversation(ctx, userId, conversation))) return [];

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();

    const commentsWithUsers = await Promise.all(
      comments.map(async (comment) => {
        const user = await ctx.db.get(comment.user_id);
        return {
          ...comment,
          user: {
            _id: user?._id,
            name: user?.name,
            github_username: user?.github_username,
            github_avatar_url: user?.github_avatar_url,
          },
        };
      })
    );

    return commentsWithUsers.sort((a, b) => a.created_at - b.created_at);
  },
});

// internal: only githubApi (a server action) calls this, to record the GitHub
// comment id after mirroring. Was a public mutation that let anyone stamp an
// arbitrary github_comment_id onto any comment.
export const updateGitHubCommentId = internalMutation({
  args: {
    comment_id: v.id("comments"),
    github_comment_id: v.number(),
  },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.comment_id);
    if (!comment) return false;
    return await patchCommentWithRevision(ctx, comment, {
      github_comment_id: args.github_comment_id,
    });
  },
});

// ── Ask the agent to reply in a comment thread ───────────────────────────────
// Opt-in: a teammate presses "Ask agent to reply". We drop a placeholder agent
// comment (status "thinking") so the UI reacts instantly, then spawn a HIDDEN
// fork of the conversation (full transcript, reusing the normal fork machinery)
// and deliver the comment thread to it as one structured prompt biased toward a
// short reply. The fork is marked is_subagent so it never shows in the feed — it
// "only lives in this thread." When its agent answers, addMessages schedules
// mirrorAgentReply, which copies the reply back into the placeholder comment.

function buildAgentThreadPrompt(
  entries: Array<{ name: string; content: string; isAgent: boolean }>,
  anchorSnippet: string | undefined,
  followUp: boolean,
): string {
  const lines: string[] = [];
  if (followUp) {
    lines.push(
      "New replies arrived in the same COMMENT THREAD you're already in. " +
        "Continue the conversation — answer the latest, concisely.",
    );
  } else {
    lines.push(
      "A teammate asked you to reply inside a COMMENT THREAD on this conversation. " +
        "These are side-channel comments between teammates (and you), not the main task.",
    );
    if (anchorSnippet) {
      lines.push("");
      lines.push("The thread is anchored to this message in the transcript:");
      lines.push(`> ${anchorSnippet}`);
    }
  }
  lines.push("");
  lines.push(followUp ? "New comments since your last reply:" : "Comment thread so far (oldest first):");
  for (const e of entries) {
    if (!e.content.trim()) continue;
    lines.push(`- ${e.isAgent ? "You (earlier)" : e.name}: ${e.content.trim()}`);
  }
  lines.push("");
  lines.push(
    "Write a reply to post back into this thread. Keep it concise and conversational — " +
      "a short, direct comment a colleague would send in chat, not a report. " +
      "Lead with the answer; skip preamble and restating the question. " +
      "Markdown is fine. Don't run tools unless the thread truly requires it.",
  );
  return lines.join("\n");
}

type AskAgentArgs = {
  conversation_id: Id<"conversations">;
  message_id?: Id<"messages">;
  client_id?: string;
};

type AskAgentExecution =
  | {
      ok: true;
      commentId: Id<"comments">;
      forkConversationId?: Id<"conversations">;
      coverageTarget?: ReturnType<typeof commentsCoverageTarget>;
    }
  | { ok: false; failure: CommentFailure };

async function executeAskAgentInThread(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: AskAgentArgs,
  validated: ValidatedCreate,
  revisionMode: CommentRevisionMode,
): Promise<AskAgentExecution> {
  const allInConversation = await ctx.db
    .query("comments")
    .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
    .collect();
  if (args.client_id) {
    const duplicate = allInConversation.find((comment) => comment.client_id === args.client_id);
    if (duplicate) {
      const matches = String(duplicate.user_id) === String(userId)
        && duplicate.author_kind === "agent"
        && sameOptionalId(duplicate.message_id, args.message_id);
      if (!matches) {
        return {
          ok: false,
          failure: {
            status: "rejected",
            code: "CLIENT_ID_REUSED",
            message: "This client id is already bound to different comment intent",
          },
        };
      }
      return {
        ok: true,
        commentId: duplicate._id,
        forkConversationId: duplicate.fork_conversation_id,
        coverageTarget: revisionMode === "receipt"
          ? commentsCoverageTarget(validated.conversation)
          : undefined,
      };
    }
  }

  const threadComments = allInConversation
    .filter((comment) => args.message_id
      ? String(comment.message_id) === String(args.message_id)
      : !comment.message_id)
    .sort((left, right) =>
      left.created_at - right.created_at || String(left._id).localeCompare(String(right._id)));

  let existingForkId: Id<"conversations"> | undefined;
  let lastAgentAt = 0;
  for (const comment of threadComments) {
    if (comment.author_kind !== "agent" || !comment.fork_conversation_id) continue;
    const fork = await ctx.db.get(comment.fork_conversation_id);
    if (
      fork
      && String(fork.comment_fork_parent) === String(args.conversation_id)
      && (await canAccessConversation(ctx, userId, fork))
    ) {
      existingForkId = comment.fork_conversation_id;
      lastAgentAt = Math.max(lastAgentAt, comment.created_at);
    }
  }
  const reuse = !!existingForkId;

  const relevant = threadComments.filter((comment) =>
    comment.content.trim().length > 0 && (!reuse || comment.created_at > lastAgentAt));
  const nameCache = new Map<string, string>();
  const entries: Array<{ name: string; content: string; isAgent: boolean }> = [];
  for (const comment of relevant) {
    const isAgent = comment.author_kind === "agent";
    let name = "Teammate";
    if (!isAgent) {
      const key = comment.user_id.toString();
      if (nameCache.has(key)) name = nameCache.get(key)!;
      else {
        const author = await ctx.db.get(comment.user_id);
        name = author?.name || author?.github_username || author?.email || "Teammate";
        nameCache.set(key, name);
      }
    }
    entries.push({ name, content: comment.content, isAgent });
  }

  const anchorSnippet = validated.message
    ? (validated.message.content || "").replace(/\s+/g, " ").trim().slice(0, 240) || undefined
    : undefined;
  const prompt = buildAgentThreadPrompt(entries, anchorSnippet, reuse);
  const now = Date.now();

  const transition = await runCommentViewTransition(
    ctx,
    validated.conversation,
    revisionMode,
    async (writer) => {
      const commentId = await writer.insert({
        conversation_id: args.conversation_id,
        message_id: args.message_id,
        user_id: userId,
        content: "",
        created_at: now,
        author_kind: "agent",
        agent_status: "thinking",
        client_id: args.client_id,
      });

      let forkId: Id<"conversations">;
      if (existingForkId) {
        forkId = existingForkId;
        await ctx.db.patch(forkId, {
          comment_fork_comment_id: commentId,
          comment_fork_prompt_at: now,
        });
      } else {
        const fork = await ctx.runMutation(api.conversations.forkFromMessage, {
          conversation_id: args.conversation_id,
        });
        forkId = fork.conversation_id as Id<"conversations">;
        await ctx.db.patch(forkId, {
          is_subagent: true,
          parent_conversation_id: args.conversation_id,
          comment_fork_parent: args.conversation_id,
          comment_fork_message_id: args.message_id?.toString(),
          comment_fork_comment_id: commentId,
          comment_fork_prompt_at: now,
          title: "Comment thread reply",
        });
      }
      await writer.patch(commentId, { fork_conversation_id: forkId });

      const forkConversation = await ctx.db.get(forkId);
      if (forkConversation) {
        await enqueuePendingMessage(ctx, forkConversation, userId, {
          content: prompt,
          // Fenced execution requires a retry-stable delivery identity. The
          // authoritative placeholder id is stable across command replay and
          // cannot be supplied or poisoned by the client.
          client_id: `comment-agent:${commentId}`,
        });
      }
      return { commentId, forkConversationId: forkId };
    },
  );

  return {
    ok: true,
    ...transition.result,
    coverageTarget: transition.coverageTarget,
  };
}

const askAgentValidators = {
  conversation_id: v.id("conversations"),
  message_id: v.optional(v.id("messages")),
  client_id: v.optional(v.string()),
};

export const askAgentInThread = mutation({
  args: askAgentValidators,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const validated = await validateCreateComment(ctx, userId, { ...args, content: "" });
    if (!validated.ok) throwLegacyCommentFailure(validated.failure);
    const executed = await executeAskAgentInThread(ctx, userId, args, validated.value, "advance");
    if (!executed.ok) throw new Error(executed.failure.message);
    return {
      comment_id: executed.commentId,
      fork_conversation_id: executed.forkConversationId,
    };
  },
});

export const askAgentInThreadV2 = mutation({
  args: { command_id: v.string(), ...askAgentValidators, client_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "comments.ask-agent/v2",
      arguments: {
        conversationId: args.conversation_id,
        messageId: args.message_id,
        clientId: args.client_id,
      },
    }, async () => {
      if (!args.client_id.trim()) return requiredClientIdFailure();
      const validated = await validateCreateComment(ctx, userId, { ...args, content: "" });
      if (!validated.ok) return validated.failure;
      const executed = await executeAskAgentInThread(ctx, userId, args, validated.value, "receipt");
      if (!executed.ok) return executed.failure;
      return {
        status: "acknowledged" as const,
        result: {
          commentId: executed.commentId,
          forkConversationId: executed.forkConversationId,
          clientId: args.client_id,
        },
        coverageViews: executed.coverageTarget ? [executed.coverageTarget] : [],
      };
    });
  },
});

// Scheduled (off the addMessages hot path) when a comment-fork produces an
// assistant message. Copies the agent's reply — the newest assistant message
// newer than the prompt, so the copied parent history never matches — into the
// placeholder comment.
export const mirrorAgentReply = internalMutation({
  args: { fork_conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const fork = await ctx.db.get(args.fork_conversation_id);
    if (!fork || !fork.comment_fork_comment_id) return;
    const comment = await ctx.db.get(fork.comment_fork_comment_id);
    if (!comment) return;
    // The fork back-link is untrusted persisted relationship data. Both sides
    // must agree before an assistant message may mutate the root projection.
    if (
      !fork.comment_fork_parent
      || String(comment.conversation_id) !== String(fork.comment_fork_parent)
      || String(comment.fork_conversation_id) !== String(fork._id)
    ) return;

    const promptAt = fork.comment_fork_prompt_at ?? 0;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.fork_conversation_id))
      .order("desc")
      .take(12);
    const reply = recent.find(
      (m) => m.role === "assistant" && (m.content || "").trim().length > 0 && m.timestamp > promptAt,
    );
    if (!reply) return;

    const content = reply.content || "";
    if (comment.content === content && comment.agent_status === "done") return;
    await patchCommentWithRevision(ctx, comment, { content, agent_status: "done" });
  },
});
