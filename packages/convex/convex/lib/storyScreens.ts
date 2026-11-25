// The screens a Changes story shows whatever its prose says: the screenshots
// its sessions posted and the pages they published, read through the same
// gate as its article (changesAccess.teamVisibleMedia, sessions the team sees
// in full only). Stored on the row so the feed shows them for every story,
// written or not; cleared with the prose whenever a story loses a session.
import { v, type Infer } from "convex/values";
import type { ChangesMedia } from "./changesAccess";

export const storyScreenValidator = v.object({
  kind: v.union(v.literal("image"), v.literal("page")),
  url: v.string(),
  /** The words around a screenshot, or a page's title: alt text, never a caption on screen. */
  caption: v.optional(v.string()),
  at: v.number(),
});

export type StoryScreen = Infer<typeof storyScreenValidator>;

/** Screens kept per story: the newest, when its sessions made more. */
export const STORY_SCREENS = 8;

/** A story's screens from its gated sessions, oldest first, each picture once. */
export function screensOf(sessions: ReadonlyArray<{ mode: string; media?: ChangesMedia }>): StoryScreen[] {
  const found: StoryScreen[] = [];
  for (const s of sessions) {
    if (s.mode !== "full" || !s.media) continue;
    for (const img of s.media.images) found.push({ kind: "image", url: img.url, at: img.timestamp, ...(img.context ? { caption: img.context } : {}) });
    for (const a of s.media.artifacts ?? []) {
      if (a.kind === "page") found.push({ kind: "page", url: a.url, at: a.timestamp, ...(a.title ? { caption: a.title } : {}) });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .filter((s) => !seen.has(s.url) && !!seen.add(s.url))
    .slice(-STORY_SCREENS);
}
