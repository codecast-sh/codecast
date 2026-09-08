import { describe, expect, test } from "bun:test";
import { checkRatchet, codeOnly } from "@codecast/shared/ratchet";
import { join } from "node:path";

// CONVERSATION VISIBILITY PATCH RATCHET.
//
// A conversation's visibility decides the stored `workspace` access key of
// every work item linked to it. patchConversationVisibility (lib/access.ts)
// is the one place that writes those fields and then recomputes the keys; a
// raw ctx.db.patch of is_private, team_visibility, auto_shared or a
// conversation's team_id changes what people may see and leaves every linked
// task, doc and plan pointing at the old workspace. CLAUDE.md names it as a
// chokepoint for exactly that reason.
//
// One file is pinned: two team_id backfills in conversations.ts stamp a team
// on conversations that have none and never recompute the linked keys. They
// are pinned rather than fixed here — the point of the pin is that the next
// bypass fails in this test rather than in a privacy report.

const ROOT = import.meta.dir;
const ALLOWLIST = join(import.meta.dir, "conversationVisibilityPatch.allowlist.txt");

// Conversation-only access fields. team_id lives on many tables, so it counts
// only when the row being patched is a conversation.
const ACCESS_FIELDS = ["is_private", "team_visibility", "auto_shared"];

/** The text between a call's parentheses, matched rather than guessed: the
 *  argument object routinely contains parentheses of its own. */
function callArguments(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return src.slice(openParen + 1);
}

function rawVisibilityPatches(source: string): number {
  const src = codeOnly(source);
  const call = /\.\s*patch\s*\(/g;
  let match: RegExpExecArray | null;
  let hits = 0;
  while ((match = call.exec(src)) !== null) {
    const args = callArguments(src, match.index + match[0].length - 1);
    const wroteAccessField = ACCESS_FIELDS.some((f) => new RegExp(`\\b${f}\\s*:`).test(args));
    // `ctx.db.patch(conv._id, { team_id })` re-routes AND re-scopes the row.
    const target = args.split(",")[0] ?? "";
    const movedConversationTeam = /conv/i.test(target) && /\bteam_id\s*[:,}]/.test(args);
    if (wroteAccessField || movedConversationTeam) hits++;
  }
  return hits;
}

/** How many files patch conversation visibility outside the chokepoint. */
const PIN = 0;

const result = checkRatchet({
  name: "raw conversation visibility patch",
  root: ROOT,
  dirs: ["."],
  exempt: (rel) =>
    // The chokepoint itself, and tests that assert on stored rows directly.
    rel === "lib/access.ts" || /\.test\.ts$/.test(rel) || rel.startsWith("__tests__/"),
  count: rawVisibilityPatches,
  allowlist: ALLOWLIST,
  pin: PIN,
  fix: "Call patchConversationVisibility from lib/access.ts instead — it patches the row and rewrites the workspace key of every linked work item.",
  pruneCommand: "cd packages/convex && RATCHET_WRITE=prune bun test convex/conversationVisibilityPatch.ratchet.test.ts",
  minScanned: 100,
});

describe("conversation visibility patch ratchet", () => {
  test("only patchConversationVisibility writes a conversation's access fields", () => {
    expect(result.problems).toEqual([]);
  }, 120_000);
});
