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
const TRACKED = [
  "conversations",
  "tasks",
  "docs",
  "plans",
  "projects",
];

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

  // Closure for the patch/delete class the insert scan cannot see (sync-
  // convergence C9): a file that imports the raw mutation builders can patch or
  // delete a tracked table without emitting a sync action, whatever it writes
  // today. So the raw builders are allowed ONLY on this explicit list — each
  // entry names the untracked table it writes — and adding a file to it is a
  // review event, not a merge accident. Anything else imports from ./functions.
  const RAW_BUILDER_ALLOWLIST: Record<string, string> = {
    "apnsVoip.ts": "VoIP push token bookkeeping (apns tables) — untracked",
    "artifacts.ts": "published pages, versions and comments — untracked",
    "buckets.ts": "inbox_buckets / bucket_assignments through the revision-bound writer — untracked",
    "callChat.ts": "call room chat rows — untracked",
    "calls.ts": "call rooms and participants — untracked",
    "debugTmpDiet.ts": "temporary conversation doc diet sweep; sheds legacy blobs nothing renders, so no delta is worth logging — deleted with debugTmp.ts",
    "oauthConnectors.ts": "oauth connector state — untracked",
    "searchMirror.ts": "search mirror rows — untracked",
    "storyMode.ts": "story mode state — untracked",
    "transcripts.ts": "call transcripts and segments — untracked",
  };

  test("only allowlisted files import raw mutation builders, and none of them writes a tracked table", () => {
    const offenders: string[] = [];
    const trackedWriters: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "functions.ts") continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (!importsRawBuilder(src)) continue;
      if (!(f in RAW_BUILDER_ALLOWLIST)) offenders.push(f);
      // A raw-builder file that queries a tracked table AND patches/deletes has
      // the bypass in reach; the reason column above says it never does. The
      // diet sweep is exempt by name: it strips fields nothing renders and is
      // slated for deletion, so its patches never need to reach the sync log.
      const readsTracked = TRACKED.some((t) => src.includes(`.query("${t}")`));
      const writes = /\.(patch|delete)\(/.test(src);
      if (readsTracked && writes && f !== "debugTmpDiet.ts") trackedWriters.push(f);
    }
    expect(offenders).toEqual([]);
    expect(trackedWriters).toEqual([]);
    // The list is exact: an entry whose file no longer imports raw builders is stale.
    for (const f of Object.keys(RAW_BUILDER_ALLOWLIST)) {
      expect(importsRawBuilder(readFileSync(join(DIR, f), "utf8"))).toBe(true);
    }
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

    for (const f of [
      "tasks.ts",
      "docs.ts",
      "plans.ts",
      "projects.ts",
      "conversationLinks.ts",
    ]) {
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
    // Naming individual functions pinned the shape of the moment: the closed-PR
    // handler stopped calling updatePRState when it moved to the shared
    // patchPullRequest, and this test failed while nothing had gone wrong. What
    // matters is the boundary, so that is what is pinned now: the webhook file
    // reaches the pull_requests module ONLY through internal.
    const src = readFileSync(join(DIR, "githubWebhooks.ts"), "utf8");
    expect(src).not.toContain("api.pull_requests.");

    const refs = src.match(/(?<![a-zA-Z.])[a-zA-Z]+\.pull_requests\.[a-zA-Z]+/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.startsWith("internal."))).toEqual([]);
  });
});

describe("comments complete-view write choke", () => {
  test("comment inserts exist only inside the revision-aware writer", () => {
    // The generic bound-writer factory owns the single raw insert; no module
    // may write the comments table by literal name at all.
    const insertWriters: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (src.includes('.insert("comments"')) insertWriters.push(f);
    }
    expect(insertWriters).toEqual([]);

    const writer = readFileSync(join(DIR, "commentViewWrites.ts"), "utf8");
    expect(writer).toContain("runCommentViewTransition");
    expect(writer).toContain('table: "comments"');
    expect(writer).toContain("revisionPrincipalId: conversation.user_id");

    const factory = readFileSync(join(DIR, "lib", "viewWriters.ts"), "utf8");
    expect(factory).toContain("advanceLocalViewRevision");
    expect(factory).toContain("ctx.db.insert(binding.table");
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

  test("every v2 command handler carries the command-id echo coverage", () => {
    // Stamped-log-ts clients retire optimistic overlays only when a view
    // result echoes their command id (design §11.4 proof #3). A handler that
    // forgets the command-id coverage strands its command in
    // acknowledged-awaiting-coverage forever under the v3 contracts.
    const comments = readFileSync(join(DIR, "comments.ts"), "utf8");
    const commentSites = comments.match(/coverageCommandIds: \[commentsCommandIdCoverage\(/g) ?? [];
    expect(commentSites.length).toBeGreaterThanOrEqual(5);
    const buckets = readFileSync(join(DIR, "buckets.ts"), "utf8");
    const bucketSites = buckets.match(/coverageCommandIds: \[\{ kind: "command-id"/g) ?? [];
    expect(bucketSites.length).toBeGreaterThanOrEqual(3);
    // And both view queries must echo the caller's receipts.
    expect(comments).toContain("echoedCommandIdsForView(ctx, userId,");
    expect(buckets).toContain("echoedCommandIdsForView(ctx, userId,");
  });

  test("access-changing conversation mutations advance the comment view head", () => {
    // The client refuses to re-grant a comment view at a revision it already
    // observed before a forbidden transition (stale cached results must not
    // resurrect revoked content). Privacy/visibility/team transitions change
    // access without any comment write, so each must move the head forward or
    // regained access renders a frozen empty thread (matrix SRV-02).
    const conversations = readFileSync(join(DIR, "conversations.ts"), "utf8");
    const advanceCalls = conversations.match(/advanceCommentsAccessRevision\(/g) ?? [];
    // setPrivacy, setTeamVisibility, setPrivacyBySessionId, reconfigureSession,
    // and the two internal share repairs.
    expect(advanceCalls.length).toBeGreaterThanOrEqual(6);
    const writer = readFileSync(join(DIR, "commentViewWrites.ts"), "utf8");
    expect(writer).toContain("export async function advanceCommentsAccessRevision");
  });
});

describe("small principal-view write chokes", () => {
  test("principal metadata and team writes pass through the central interceptor", () => {
    const functions = readFileSync(join(DIR, "functions.ts"), "utf8");
    expect(functions).toContain("makePrincipalViewTrackedDb(makeChangeTrackedDb(ctx.db, collector))");

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
    // The generic bound-writer factory owns the single raw insert; no module
    // may write the bookmarks table by literal name at all.
    const insertWriters: string[] = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(DIR, f), "utf8");
      if (src.includes('.insert("bookmarks"')) insertWriters.push(f);
    }
    expect(insertWriters).toEqual([]);

    const writer = readFileSync(join(DIR, "bookmarkViewWrites.ts"), "utf8");
    expect(writer).toContain('table: "bookmarks"');
    expect(writer).toContain("runBookmarkViewTransition");

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
