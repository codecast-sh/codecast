// Completions for the session query's file: operator. The web search box and
// the command palette offer the files the viewer's own recent sessions edited,
// repo-relative, so `file:` finishes to a path the index will actually match.
// Reads only the viewer's own conversation rows (their denormalized
// recent_files), newest first: no edit rows, no bodies, no one else's data.

import { query } from "./functions";
import { requireUser } from "./lib/auth";
import { recentFilesFromSessions } from "@codecast/shared/search";

const SESSIONS = 60;
const FILES = 200;

export const recentFiles = query({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const userId = await requireUser(ctx);
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (ix) => ix.eq("user_id", userId))
      .order("desc")
      .take(SESSIONS);
    return recentFilesFromSessions(convs, FILES);
  },
});
