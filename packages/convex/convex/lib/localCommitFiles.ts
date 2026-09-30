import { v } from "convex/values";

// The files a local commit touched with their line counts (git log --numstat).
// It lives in a leaf so gitActivity.ts can read it at load without importing
// repos.ts for a value: repos.ts reaches gitActivity.ts back through
// lib/access.ts, so a top-level read across that edge throws a TDZ
// ReferenceError whenever repos.ts loads first.
export const localCommitFiles = v.array(v.object({ filename: v.string(), additions: v.number(), deletions: v.number() }));
