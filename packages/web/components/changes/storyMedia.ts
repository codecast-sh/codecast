// What a story shows besides its words: the screenshots, published pages and
// canvases its article placed (changesProse articleBody writes them as
// markdown images, a page URL alone on its line, and cast-canvas fences), and
// the screens its sessions made that the article did not place (the row's
// `screens`, stored whether or not prose was written).
// A story's card shows its first as a thumbnail, and leads with it when open.
// Pure, for the page and tests.
import type { StoryRow } from "../../hooks/useSyncChanges";

export type StoryMedia =
  | { kind: "image"; src: string; alt: string }
  | { kind: "page"; slug: string; url: string; title?: string }
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

const PAGE_SLUG = /codecast\.sh\/a\/([\w-]+)/;

/** The screens the story's sessions made that its article did not place, oldest first. */
export function extraScreens(story: Pick<StoryRow, "body" | "screens">): StoryMedia[] {
  const body = story.body ?? "";
  return (story.screens ?? [])
    .filter((s) => !body.includes(s.url))
    .flatMap((s): StoryMedia[] => {
      if (s.kind === "image") return [{ kind: "image", src: s.url, alt: s.caption ?? "" }];
      const slug = PAGE_SLUG.exec(s.url)?.[1];
      return slug ? [{ kind: "page", slug, url: s.url, ...(s.caption ? { title: s.caption } : {}) }] : [];
    });
}

/**
 * The story's first screenshot or published page, lifted out to lead it, and
 * the article without it, so the picture shows once. A canvas stays in place:
 * it reads as part of the argument, not as a cover.
 */
export function leadMedia(body: string | undefined): { lead: StoryMedia | null; rest: string } {
  if (!body) return { lead: null, rest: "" };
  const image = new RegExp(IMAGE.source).exec(body);
  const page = new RegExp(PAGE.source, "m").exec(body);
  const first = [image, page].filter((m): m is RegExpExecArray => !!m).sort((a, b) => a.index - b.index)[0];
  if (!first) return { lead: null, rest: body };
  const lead: StoryMedia = first === image ? { kind: "image", src: first[2], alt: first[1].trim() } : { kind: "page", url: first[1], slug: first[2] };
  return { lead, rest: (body.slice(0, first.index) + body.slice(first.index + first[0].length)).replace(/\n{3,}/g, "\n\n").trim() };
}
