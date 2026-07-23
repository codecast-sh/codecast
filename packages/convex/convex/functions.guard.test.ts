import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Coverage guard: the change feed is only complete if every file that WRITES a
// tracked table routes its mutations through ./functions (the write interceptor),
// not the raw ./_generated/server builders. This turns the "did someone forget to
// emit?" discipline problem into a CI failure.
//
// Reliable signal: a file that `.insert("<tracked>")` must NOT import
// mutation/internalMutation from ./_generated/server. (Patch/delete-only writers
// can't be detected statically by table name, but they live in the same core
// files this catches, and they go through the same wrapped ctx.db regardless.)
const DIR = import.meta.dir;
const TRACKED = ["conversations", "tasks", "docs", "plans"];

function importsRawBuilder(src: string): boolean {
  const blocks = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/_generated\/server["']/g)];
  return blocks.some((m) => /\b(mutation|internalMutation)\b/.test(m[1]));
}

function insertsTrackedTable(src: string): boolean {
  return TRACKED.some((t) => src.includes(`.insert("${t}"`));
}

describe("change-feed write interceptor coverage", () => {
  test("no file that inserts a tracked table imports raw mutation builders", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "functions.ts") continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (insertsTrackedTable(src) && importsRawBuilder(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("the interceptor itself stays wired to the raw generated builders", () => {
    const src = readFileSync(join(DIR, "functions.ts"), "utf8");
    expect(importsRawBuilder(src)).toBe(true);
  });

  test("wrapped builders initialize without crossing the local-command module", async () => {
    const functions = await import("./functions");
    expect(typeof functions.mutation).toBe("function");
    expect(typeof functions.internalMutation).toBe("function");

    const principalRevisions = readFileSync(join(DIR, "principalViewRevisions.ts"), "utf8");
    expect(principalRevisions).toContain('from "./localViewRevisions"');
    expect(principalRevisions).not.toContain('from "./localFirstCommands"');
    const neutral = readFileSync(join(DIR, "localViewRevisions.ts"), "utf8");
    expect(neutral).not.toContain('from "./functions"');
    expect(neutral).not.toMatch(/import\s*\{[^}]*\b(query|mutation|internalMutation)\b[^}]*\}/);
  });
});

describe("authorization boundary coverage", () => {
  test("the public data context exposes no raw or unscoped database escape hatch", () => {
    const data = readFileSync(join(DIR, "data.ts"), "utf8");
    expect(data).not.toMatch(/\braw:\s*ctx\.db/);
    expect(data).not.toMatch(/get\s+unscoped\s*\(/);

    for (const f of ["tasks.ts", "docs.ts", "plans.ts", "projects.ts"]) {
      const src = readFileSync(join(DIR, f), "utf8");
      expect(src).not.toMatch(/\.(raw|unscoped)\b/);
    }
  });

  test("webhook-only pull request writers stay internal", () => {
    const src = readFileSync(join(DIR, "pull_requests.ts"), "utf8");
    for (const name of ["create", "syncPRFromGitHub", "linkPRToSession", "updatePRFiles", "updatePRState"]) {
      expect(src).toMatch(new RegExp(`export const ${name} = internalMutation\\(`));
    }
  });

  test("GitHub webhook handlers call the internal PR API", () => {
    const src = readFileSync(join(DIR, "githubWebhooks.ts"), "utf8");
    expect(src).not.toContain("api.pull_requests.updatePRFiles");
    expect(src).not.toContain("api.pull_requests.updatePRState");
    expect(src).toContain("internal.pull_requests.updatePRFiles");
    expect(src).toContain("internal.pull_requests.updatePRState");
  });
});

describe("comments complete-view write choke", () => {
  test("comment inserts exist only inside the revision-aware writer", () => {
    const insertWriters: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (src.includes('.insert("comments"')) insertWriters.push(f);
    }
    expect(insertWriters).toEqual(["commentViewWrites.ts"]);

    const writer = readFileSync(join(DIR, "commentViewWrites.ts"), "utf8");
    expect(writer).toContain("runCommentViewTransition");
    expect(writer).toContain("advanceLocalViewRevision");
    expect(writer).toContain("revisionPrincipalId: conversation.user_id");
  });

  test("every non-comment-module writer routes through the revision boundary", () => {
    const comments = readFileSync(join(DIR, "comments.ts"), "utf8");
    expect(comments).not.toContain('ctx.db.insert("comments"');
    expect(comments).toContain("runCommentViewTransition");
    expect(comments).toContain("patchCommentWithRevision");
    expect(comments).toContain("deleteCommentWithRevision");

    const dispatch = readFileSync(join(DIR, "dispatch.ts"), "utf8");
    expect(dispatch).toContain('if (table === "comments")');
    expect(dispatch).toContain("patchCommentWithRevision");
    for (const structuralField of [
      "conversation_id",
      "message_id",
      "user_id",
      "github_comment_id",
      "pr_id",
      "file_path",
      "line_number",
      "client_id",
    ]) {
      expect(dispatch).toContain(`"${structuralField}"`);
    }

    const users = readFileSync(join(DIR, "users.ts"), "utf8");
    expect(users).not.toContain("ctx.db.delete(comment._id)");
    expect(users).toContain("deleteCommentWithRevision(ctx, comment, conv)");

    const merge = readFileSync(join(DIR, "admin_mergeUser.ts"), "utf8");
    expect(merge).toContain('if (table === "comments")');
    expect(merge).toContain("patchCommentWithRevision");
  });
});

describe("small principal-view write chokes", () => {
  test("principal metadata and team writes pass through the central interceptor", () => {
    const functions = readFileSync(join(DIR, "functions.ts"), "utf8");
    expect(functions).toContain("makePrincipalViewTrackedDb(makeChangeTrackedDb(ctx.db))");

    const auth = readFileSync(join(DIR, "auth.ts"), "utf8");
    expect(auth).toContain("advanceCurrentUserViewRevision");

    const principalTables = ["users", "teams", "team_memberships"];
    const offenders: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "functions.ts") continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (
        principalTables.some((table) => src.includes(`.insert("${table}"`))
        && importsRawBuilder(src)
      ) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("bookmark row writes exist only inside the principal-bound writer", () => {
    const insertWriters: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (src.includes('.insert("bookmarks"')) insertWriters.push(f);
    }
    expect(insertWriters).toEqual(["bookmarkViewWrites.ts"]);

    const bookmarks = readFileSync(join(DIR, "bookmarks.ts"), "utf8");
    expect(bookmarks).not.toContain("ctx.db.delete(bookmark._id)");
    expect(bookmarks).toContain("insertBookmarkWithRevision");
    expect(bookmarks).toContain("deleteBookmarkWithRevision");
    expect(bookmarks).toContain("validateBookmarkTarget");

    const users = readFileSync(join(DIR, "users.ts"), "utf8");
    expect(users).toContain("deleteBookmarkWithRevision(ctx, b)");
    const merge = readFileSync(join(DIR, "admin_mergeUser.ts"), "utf8");
    expect(merge).toContain("moveBookmarkPrincipalWithRevision");
  });

  test("favorite patches route through the owner-derived writer", () => {
    const conversations = readFileSync(join(DIR, "conversations.ts"), "utf8");
    expect(conversations).toContain("toggleFavoriteWithRevision");
    expect(conversations).toContain("setFavoriteWithRevision");
    expect(conversations).not.toMatch(
      /ctx\.db\.patch\(args\.conversation_id,\s*\{\s*is_favorite\s*:/,
    );

    const dispatch = readFileSync(join(DIR, "dispatch.ts"), "utf8");
    expect(dispatch).toContain('table === "conversations" && "is_favorite" in finalSafe');
    expect(dispatch).toContain("patchConversationThroughFavoriteView");
    expect(dispatch).toContain("delete finalSafe.is_favorite");
  });
});

describe("pending-message insertion choke", () => {
  test("all producers route through one neutral raw writer", () => {
    const insertWriters: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (src.includes('.insert("pending_messages"')) insertWriters.push(f);
    }
    expect(insertWriters).toEqual(["pendingMessageWrites.ts"]);

    const writer = readFileSync(join(DIR, "pendingMessageWrites.ts"), "utf8");
    expect(writer).toContain("insertEnqueuedPendingMessage");
    expect(writer).toContain("insertRiskResendPendingMessage");
    expect(writer).not.toContain('from "./functions"');
    expect(writer).not.toContain('from "./executionBindings"');
    expect(writer).not.toContain('from "./localFirstCommands"');

    const ordinary = readFileSync(join(DIR, "pendingMessages.ts"), "utf8");
    expect(ordinary).toContain("insertEnqueuedPendingMessage");
    expect(ordinary).toContain("export const sendMessageV2");
    expect(ordinary).toContain("pendingMessageMatchesProductIntent");
    expect(ordinary).toContain("runLocalCommand");

    const fenced = readFileSync(join(DIR, "executionBindings.ts"), "utf8");
    expect(fenced).toContain("insertRiskResendPendingMessage");
  });
});
