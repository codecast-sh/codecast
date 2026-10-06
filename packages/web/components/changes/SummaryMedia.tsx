// The pictures of a day or a week: the screenshots, pages and canvases its
// stories placed, each captioned by the story it came from. A screenshot opens
// in the lightbox with the rest of the set; the caption opens the story.
import { useMemo } from "react";
import { ImageGalleryProvider, useImageGallery, type GalleryImage } from "../ImageGallery";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import type { PickedMedia } from "./storyMedia";

function Caption({ picked, onOpen }: { picked: PickedMedia; onOpen: (key: string) => void }) {
  const { story, media } = picked;
  return (
    <button
      type="button"
      onClick={() => onOpen(story.story_key)}
      className="chg-ui mt-1.5 line-clamp-2 block text-left text-[12px] leading-[1.45] text-sol-text/60 hover:text-sol-text"
      title={media.kind === "image" && media.alt ? media.alt : undefined}
    >
      {story.headline}
    </button>
  );
}

function Shots({ shots, onOpen }: { shots: PickedMedia[]; onOpen: (key: string) => void }) {
  const gallery = useImageGallery();
  const images = useMemo<GalleryImage[]>(() => shots.map((p) => (p.media.kind === "image" ? { src: p.media.src, href: p.media.src } : { src: "" })), [shots]);
  // One shot spans the column; three or more lead with a large one.
  const lead = shots.length === 1 || shots.length >= 3;
  return (
    <div className={`grid gap-x-3 gap-y-4 ${shots.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
      {shots.map((p, i) => p.media.kind === "image" && (
        <figure key={p.media.src} className={`min-w-0 ${lead && i === 0 && shots.length > 1 ? "col-span-2" : ""}`}>
          <button
            type="button"
            onClick={() => gallery?.openList(images, i)}
            className="block w-full overflow-hidden rounded-md border border-sol-border/30 bg-sol-bg-alt/60 outline-none transition-[border-color,transform] duration-150 hover:border-sol-border/70 focus-visible:border-sol-text/60 active:scale-[0.995]"
            aria-label={p.media.alt || `Screenshot from ${p.story.headline}`}
          >
            <img
              src={p.media.src}
              alt={p.media.alt}
              loading="lazy"
              className={`w-full object-cover object-top ${lead && i === 0 ? "aspect-[16/9]" : "aspect-[16/10]"}`}
            />
          </button>
          <Caption picked={p} onOpen={onOpen} />
        </figure>
      ))}
    </div>
  );
}

export function SummaryMedia({ media, onOpen }: { media: PickedMedia[]; onOpen: (key: string) => void }) {
  if (!media.length) return null;
  const shots = media.filter((p) => p.media.kind === "image");
  const rest = media.filter((p) => p.media.kind !== "image");
  return (
    <ImageGalleryProvider>
      <div className="mt-4 space-y-4" data-chg-media>
        {shots.length > 0 && <Shots shots={shots} onOpen={onOpen} />}
        {rest.map((p) => (
          <figure key={p.media.kind === "page" ? p.media.slug : p.media.kind === "canvas" ? p.media.block.slice(0, 80) : ""} className="min-w-0">
            {p.media.kind === "page" ? <PublishedPageEmbed slug={p.media.slug} height={300} /> : p.media.kind === "canvas" ? <MarkdownRenderer content={p.media.block} /> : null}
            <Caption picked={p} onOpen={onOpen} />
          </figure>
        ))}
      </div>
    </ImageGalleryProvider>
  );
}
