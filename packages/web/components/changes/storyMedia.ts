// What a story shows besides its words: the screenshots, published pages and
// canvases its article placed (changesProse articleBody writes them as
// markdown images, a page URL alone on its line, and cast-canvas fences).
// Days and weeks read them from their stories, so a summary at any zoom
// carries the pictures of the work it summarizes. Pure, for the page and tests.
import type { StoryRow } from "../../hooks/useSyncChanges";

export type StoryMedia =
  | { kind: "image"; src: string; alt: string }
  | { kind: "page"; slug: string; url: string }
  | { kind: "canvas"; block: string };

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const PAGE = /^\s*(https?:\/\/(?:www\.)?codecast\.sh\/a\/([\w-]+)\S*)\s*$/gm;
const CANVAS = /```cast-canvas\n[\s\S]*?\n```/g;

/** The story's media in article order. */
export function mediaOf(body: string | undefined): StoryMedia[] {
  if (!body) return [];
  const found: Array<{ at: number; media: StoryMedia }> = [];
  for (const m of body.matchAll(IMAGE)) found.push({ at: m.index ?? 0, media: { kind: "image", src: m[2], alt: m[1].trim() } });
  for (const m of body.matchAll(PAGE)) found.push({ at: m.index ?? 0, media: { kind: "page", url: m[1], slug: m[2] } });
  for (const m of body.matchAll(CANVAS)) found.push({ at: m.index ?? 0, media: { kind: "canvas", block: m[0] } });
  return found.sort((a, b) => a.at - b.at).map((f) => f.media);
}

export type PickedMedia = { story: StoryRow; media: StoryMedia };

/**
 * Up to `max` pieces of media from stories already in reading order: each
 * story's first piece before any story's second, so one busy story cannot
 * fill a summary that covers many. The same picture placed twice shows once.
 */
export function pickMedia(stories: readonly StoryRow[], max: number): PickedMedia[] {
  const lists = stories.map((story) => ({ story, media: mediaOf(story.body) })).filter((l) => l.media.length);
  const out: PickedMedia[] = [];
  const seen = new Set<string>();
  for (let round = 0; out.length < max && lists.some((l) => l.media.length > round); round++) {
    for (const l of lists) {
      const media = l.media[round];
      if (!media || out.length >= max) continue;
      const id = media.kind === "image" ? media.src : media.kind === "page" ? media.slug : media.block;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ story: l.story, media });
    }
  }
  return out;
}
