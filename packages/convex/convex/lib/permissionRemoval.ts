import { v } from "convex/values";

/** One rm target on a permission card, as the daemon resolved it from the disk
 *  (packages/cli/src/removalPreview.ts): the absolute path or pattern, how many
 *  files and folders it matched, or why it could not be counted. */
export const permissionRemovalValidator = v.object({
  target: v.string(),
  files: v.optional(v.number()),
  dirs: v.optional(v.number()),
  note: v.optional(v.string()),
});
