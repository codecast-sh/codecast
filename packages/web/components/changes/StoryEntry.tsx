// One change in the feed, at two depths. Closed, it is a card read at a
// glance: the headline, the dek, who and when, and a thumbnail of its first
// screen; a small change is one line. Open (a click, or Enter), the same card
// holds everything worth reading: its screens large, its article, its risks in
// words, when it went live, and the sessions and pull requests behind it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Link2 } from "lucide-react";
import { memo, useMemo } from "react";
import type { StoryRow as Story } from "../../hooks/useSyncChanges";
import { DiffStat } from "../entityDisplay";
import { EntityIdPill } from "../EntityIdPill";
import { ImageGalleryProvider, useImageGallery } from "../ImageGallery";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { MarkdownImageSize } from "../../lib/markdownImageSize";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { plural } from "./format";
import { Byline, FadeText, KindGlyph, People, RiskLine, Timing, clockOf, waitingOn } from "./StoryParts";
import { useIsOpen, useStoryAttrs, useStoryCtx } from "./storyContext";
import { extraScreens, leadMedia, mediaOf, type StoryMedia } from "./storyMedia";
import { commitPath, largestCommitHref } from "./storyTarget";
import { KeyHint } from "./useChangesKeys";
import { RISK_HATCH } from "./areaColor";

const ARTICLE =
  "chg-article mt-3 max-w-[46rem] text-[14px] leading-[1.7] text-sol-text/80 prose-p:my-2 prose-p:text-sol-text/80 prose-li:my-0.5 prose-li:text-sol-text/80 prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-sol-text prose-h3:mb-2 prose-h3:mt-5 prose-h3:text-[15.5px] prose-h3:leading-snug prose-h4:mb-1 prose-h4:mt-4 prose-h4:text-[14px] [&>*:first-child]:mt-0 prose-code:rounded prose-code:bg-sol-bg-alt prose-code:px-1 prose-code:py-px prose-code:text-[12.5px] prose-code:font-medium prose-code:text-sol-text prose-code:before:content-none prose-code:after:content-none prose-blockquote:my-3 prose-blockquote:rounded-r-md prose-blockquote:border-l-2 prose-blockquote:border-sol-border/60 prose-blockquote:bg-sol-bg-alt/60 prose-blockquote:py-1 prose-blockquote:pl-4 prose-blockquote:pr-3 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-sol-text/75 [&_blockquote_p:before]:content-none [&_blockquote_p:after]:content-none prose-img:rounded-md prose-img:border prose-img:border-sol-border/30";

/** The size of the change, linked to its largest commit (sized from the commits the store holds when clicked). */
function Size({ story }: { story: Story }) {
  const router = useRouter();
  const first = story.commit_shas[0];
  return (
    <Link
      href={commitPath(story.repository, first)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        router.push(largestCommitHref(story) ?? commitPath(story.repository, first));
      }}
      className="inline-flex items-center gap-1.5 rounded underline-offset-2 hover:text-sol-text hover:underline"
    >
      <DiffStat additions={story.insertions} deletions={story.deletions} themed />
      <span>{plural(story.commit_shas.length, "commit")}</span>
    </Link>
  );
}

type Shot = Extract<StoryMedia, { kind: "image" }>;

/** Opens the story's screenshots in the lightbox, starting at `shot`. */
function useOpenShot(all: readonly StoryMedia[]) {
  const gallery = useImageGallery();
  return (shot: Shot) => {
    const shots = all.filter((m): m is Shot => m.kind === "image");
    gallery?.openList(shots.map((m) => ({ src: m.src, href: m.src })), Math.max(0, shots.findIndex((m) => m.src === shot.src)));
  };
}

/**
 * What a change shows before its words: its lead screen (a screenshot, or the
 * page it published) large, then the rest of its sessions' screens as
 * thumbnails. Screenshots open in the lightbox with every one of the story's.
 */
function Screens({ lead, more, all }: { lead: StoryMedia; more: readonly StoryMedia[]; all: readonly StoryMedia[] }) {
  const open = useOpenShot(all);
  const shots = more.filter((m): m is Shot => m.kind === "image");
  const pages = more.filter((m) => m.kind === "page");
  const thumb = (m: Shot, cls: string) => (
    <button
      key={m.src}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(m);
      }}
      aria-label={m.alt || "Open the screenshot"}
      title={m.alt || undefined}
      className={`block w-full overflow-hidden rounded-lg border border-sol-border/30 bg-sol-bg-alt/60 outline-none transition-[border-color] duration-150 hover:border-sol-border/70 focus-visible:border-sol-text/60 ${cls}`}
    >
      <img src={m.src} alt={m.alt} loading="lazy" className="h-full w-full object-cover object-top" />
    </button>
  );
  return (
    <div className="mt-3 space-y-2">
      {lead.kind === "page" ? <PublishedPageEmbed slug={lead.slug} height={420} /> : lead.kind === "image" ? thumb(lead, "max-h-[32rem] [&_img]:h-auto") : null}
      {shots.length > 0 && <div className="grid grid-cols-3 gap-2">{shots.map((m) => thumb(m, "aspect-[16/10]"))}</div>}
      {pages.map((m) => m.kind === "page" && <PublishedPageEmbed key={m.slug} slug={m.slug} height={320} />)}
    </div>
  );
}

/** The story's screens and article, split once: the lead screen, the rest of its sessions' screens, the article without its lead. */
function useStoryMedia(story: Story) {
  return useMemo(() => {
    const { lead, rest } = leadMedia(story.body);
    const extra = extraScreens(story);
    const first = lead ?? extra[0] ?? null;
    const more = lead ? extra : extra.slice(1);
    return { lead: first, more, rest, all: [...(first ? [first] : []), ...more, ...mediaOf(rest)] };
  }, [story]);
}

/** The closed card's picture: its first screenshot, small; else the page it published, as a tile with the page's title. */
function Thumb({ all }: { all: readonly StoryMedia[] }) {
  const media = all.find((m) => m.kind === "image") ?? all.find((m) => m.kind === "page");
  if (!media || media.kind === "canvas") return null;
  if (media.kind === "image") {
    return <img src={media.src} alt="" loading="lazy" className="h-[84px] w-[136px] shrink-0 rounded-md border border-sol-border/30 bg-sol-bg-alt/60 object-cover object-top" />;
  }
  return (
    <span className="flex h-[84px] w-[136px] shrink-0 flex-col justify-between rounded-md border border-sol-border/30 bg-sol-bg-alt/60 p-2.5">
      <FileText className="h-4 w-4 text-sol-text-dim" />
      <span className="chg-ui line-clamp-2 text-[12px] font-medium leading-[1.3] text-sol-text/75">{media.title || "Published page"}</span>
    </span>
  );
}

/** Everything the open card adds: screens, article, risks, then when it went live and what made it. */
function Opened({ story, media }: { story: Story; media: ReturnType<typeof useStoryMedia> }) {
  const ctx = useStoryCtx();
  return (
    // Reading matter: a click inside follows its own link or image and leaves the card open.
    <div className="cursor-auto pb-1 pl-5" onClick={(e) => e.stopPropagation()}>
      <ImageGalleryProvider key={story.story_key}>
        {media.lead && <Screens lead={media.lead} more={media.more} all={media.all} />}
        {media.rest && (
          <MarkdownImageSize.Provider value="whole">
            <MarkdownRenderer content={media.rest} className={ARTICLE} />
          </MarkdownImageSize.Provider>
        )}
      </ImageGalleryProvider>
      <RiskLine story={story} className="mt-3" />
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-sol-border/20 pt-3 font-mono text-meta tabular-nums text-sol-text-muted">
        <Timing story={story} live={ctx.live} />
        {story.commit_shas.length > 0 && <Size story={story} />}
        {story.conversation_ids.slice(0, 4).map((id) => <EntityIdPill key={String(id)} type="session" id={String(id)} compact />)}
        {story.conversation_ids.length > 4 && <span className="text-sol-text-dim">+{story.conversation_ids.length - 4}</span>}
        {story.pr_ids.map((id) => <EntityIdPill key={String(id)} type="pr" id={String(id)} compact />)}
        {story.private_session_count > 0 && <span className="text-sol-text-dim">{plural(story.private_session_count, "private session")}</span>}
        {ctx.copyLink && (
          <button
            type="button"
            onClick={() => ctx.copyLink?.(story)}
            className="ml-auto inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
          >
            <Link2 className="h-3 w-3" />
            Copy link
            <KeyHint action="changes.copyLink" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One change. `small` is housekeeping: one line closed. Either opens in place;
 * the open card is marked by its fill, and the cursor (j/k, a click) by a
 * faint tint.
 */
export const StoryEntry = memo(function StoryEntry({ story, small = false }: { story: Story; small?: boolean }) {
  const ctx = useStoryCtx();
  const key = story.story_key;
  const attrs = useStoryAttrs(key);
  const open = useIsOpen(key);
  const media = useStoryMedia(story);
  // The pending bar holds the dek's place only while notes can still come.
  const pending = !story.dek && story.prose_status === "pending" && !!ctx.proseLive;
  const notLive = !story.release && waitingOn(story, ctx.live ?? []).length > 0;
  const screens = media.all.filter((m) => m.kind !== "canvas").length;
  const line = small && !open;
  return (
    <article
      {...attrs}
      data-story-trigger
      data-open={open || undefined}
      tabIndex={0}
      aria-expanded={open}
      aria-label={story.headline}
      className={`chg-story chg-entry group relative -mx-3 cursor-pointer rounded-lg px-3 outline-none ${line ? "py-1.5" : "py-2.5"} ${open ? "my-2 border border-sol-border/30 bg-sol-bg-alt/40 py-4" : ""}`}
      onClick={() => {
        ctx.pick(key);
        ctx.toggle(key);
      }}
    >
      {line ? (
        <div className="flex min-w-0 items-baseline gap-2">
          <KindGlyph kind={story.kind} />
          <span className="chg-ui min-w-0 flex-1 text-[13.5px] leading-[1.45] text-sol-text/80 [overflow-wrap:anywhere]"><FadeText text={story.headline} /></span>
          <span className="shrink-0 self-center"><People story={story} size={16} max={2} /></span>
          <span className="w-[3rem] shrink-0 text-right font-mono text-meta tabular-nums text-sol-text-dim">{clockOf(story.last_at)}</span>
        </div>
      ) : (
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              {/* One headline line tall, so the glyph centers on the first line and adds no height. */}
              <span className={`flex shrink-0 items-center ${open ? "h-[25px]" : "h-[21px]"}`}><KindGlyph kind={story.kind} /></span>
              <h3 className={`chg-ui min-w-0 flex-1 font-semibold leading-[1.4] tracking-[-0.005em] text-sol-text [overflow-wrap:anywhere] ${open ? "text-[18px] font-bold" : "text-[15px]"}`}>
                <FadeText text={story.headline} />
              </h3>
            </div>
            {(pending || story.dek) && (
              <p className="chg-ui mt-0.5 pl-5 text-[13.5px] leading-[1.5] text-sol-text/65 [overflow-wrap:anywhere]">
                {pending ? <span className="chg-pending-bar" role="img" aria-label="Notes pending" /> : <FadeText text={story.dek} />}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 font-mono text-meta tabular-nums text-sol-text-dim">
              <Byline story={story} size={16} />
              <span>{clockOf(story.last_at)}</span>
              {story.insertions + story.deletions > 0 && <span>{story.insertions > 0 ? `+${story.insertions.toLocaleString()}` : `-${story.deletions.toLocaleString()}`}</span>}
              {!open && screens > 1 && <span>{plural(screens, "screen")}</span>}
              {notLive && <span className="text-[var(--sol-yellow)]">not deployed</span>}
              {story.risks.length > 0 && <span aria-label="Has risks" title="Has risks" className="h-2.5 w-3.5 rounded-[2px]" style={{ background: RISK_HATCH }} />}
            </div>
          </div>
          {!open && <Thumb all={media.all} />}
        </div>
      )}
      {open && <Opened story={story} media={media} />}
    </article>
  );
});
