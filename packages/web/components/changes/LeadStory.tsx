// The lead story (spec 4.4): the day's one card, with a 2px rail in its area
// color (a risk hatch in its place when flagged), the release that carried
// it, a 22px headline, the dek and body, where the "why" came from, and the
// people, sessions and diffstat behind it in one footer row. `e` opens its
// evidence. When the edition headline above already says the lead's headline,
// the card opens with the dek and reads as its continuation. An area filter
// that misses the lead folds it to its title line.
import * as Accordion from "@radix-ui/react-accordion";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { DiffStat, MetaDot } from "../entityDisplay";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { AreaTag, FadeText, People, Provenance, ReleaseTag, SessionPills, StoryEdge, Tip, hasProvenance, riskLines, riskText } from "./StoryParts";
import { useStoryAttrs, useStoryCtx } from "./storyContext";
import { KeyHint } from "./useChangesKeys";

export function LeadStory({ story, open, echo = false, collapsed = false }: {
  story: StoryRow;
  open: boolean;
  /** The edition headline already says this story's headline (editionModel.echoesHeadline). */
  echo?: boolean;
  /** An area filter misses the lead while other stories match: it folds to its title line, so the matches rise. */
  collapsed?: boolean;
}) {
  const ctx = useStoryCtx();
  const key = story.story_key;
  const risks = riskLines(story);
  const pending = !story.dek && story.prose_status === "pending";
  // Without a dek the headline is all the card has to say, repeat or not.
  const continues = echo && !!story.dek;
  const commits = story.commit_shas.length;
  const attrs = useStoryAttrs(key);
  if (collapsed) {
    return (
      <Accordion.Item
        value={key}
        {...attrs}
        className="chg-story chg-row relative rounded-md py-1 pl-3 pr-1.5 transition-opacity duration-200 motion-reduce:transition-none"
        style={{ opacity: 0.5 }}
        onClick={() => ctx.pick(key)}
      >
        <StoryEdge story={story} />
        <Accordion.Header asChild>
          <div>
            <Accordion.Trigger data-story-trigger className="flex w-full min-w-0 items-baseline gap-2 text-left outline-none">
              <span className="chg-ui min-w-0 flex-1 truncate text-[14px] font-medium leading-[1.4] text-sol-text/90">
                <FadeText text={story.headline} />
              </span>
              <AreaTag area={story.area} className="shrink-0" />
            </Accordion.Trigger>
          </div>
        </Accordion.Header>
        <Accordion.Content className="chg-drawer">
          <EvidenceDrawer story={story} />
        </Accordion.Content>
      </Accordion.Item>
    );
  }
  return (
    <Accordion.Item
      value={key}
      {...attrs}
      className="chg-story relative overflow-hidden rounded-lg border border-sol-border/25 bg-sol-card px-5 py-4 shadow-sm transition-opacity duration-200 motion-reduce:transition-none"
      onClick={() => ctx.pick(key)}
      style={{ opacity: ctx.dimmed.has(key) ? 0.35 : 1 }}
    >
      <StoryEdge story={story} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AreaTag area={story.area} />
        <ReleaseTag story={story} />
        {ctx.waiting.has(key) && <span className="font-mono text-[11px] text-sol-text/55">waiting to ship</span>}
        {!story.on_default_branch && <span className="font-mono text-[11px] text-sol-text/55">on {story.branch}</span>}
      </div>
      <h2 className={continues ? "sr-only" : "chg-ui mt-2 text-[22px] font-semibold leading-[1.25] text-sol-text [overflow-wrap:anywhere] [text-wrap:pretty]"}>
        <FadeText text={story.headline} />
      </h2>
      {continues ? (
        <p className="chg-ui chg-lead-prose mt-2 text-[17px] font-medium leading-[1.5] text-sol-text [overflow-wrap:anywhere]">
          <FadeText text={story.dek} />
        </p>
      ) : (
        <p className="chg-ui chg-lead-prose mt-1.5 min-h-[1.6em] text-[15px] leading-[1.6] text-sol-text/80 [overflow-wrap:anywhere]">
          {pending ? <span className="chg-pending-bar" role="img" aria-label="Notes pending" /> : <FadeText text={story.dek} />}
        </p>
      )}
      {story.body && (
        <p className="chg-ui chg-lead-prose mt-2 text-[15px] leading-[1.6] text-sol-text/80 [overflow-wrap:anywhere]">
          <FadeText text={story.body} />
        </p>
      )}
      {risks.length > 0 && (
        <p className="chg-ui chg-lead-prose mt-2 flex items-start gap-2 text-[13px] leading-[1.55] text-sol-text/70">
          <span aria-hidden className="chg-hatch mt-[0.45em] h-2.5 w-3.5 shrink-0 rounded-[2px]" />
          {/* One line on the card; every risk, worded with its evidence, on hover. */}
          <Tip text={<span className="whitespace-pre-line">{riskText(story)}</span>}>
            <span className="line-clamp-1 min-w-0 flex-1 [overflow-wrap:anywhere]">{risks.join(" ")}</span>
          </Tip>
        </p>
      )}
      <Accordion.Header asChild>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {hasProvenance(story) && (
            <>
              <Provenance story={story} />
              <MetaDot />
            </>
          )}
          <span className="font-mono text-[11px] tabular-nums text-sol-text/55">
            {commits} {commits === 1 ? "commit" : "commits"}
          </span>
          <DiffStat additions={story.insertions} deletions={story.deletions} className="text-[11px]" themed />
          <People story={story} />
          <SessionPills story={story} />
          <Accordion.Trigger data-story-trigger className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-sol-text/60 outline-none transition-colors hover:bg-sol-bg-alt hover:text-sol-text focus-visible:ring-1 focus-visible:ring-sol-border">
            <KeyHint action="changes.evidence" />
            {open ? "hide evidence" : "evidence"}
          </Accordion.Trigger>
        </div>
      </Accordion.Header>
      <Accordion.Content className="chg-drawer">
        <EvidenceDrawer story={story} />
      </Accordion.Content>
    </Accordion.Item>
  );
}
