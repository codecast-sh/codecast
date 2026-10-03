// The lead story (spec 4.4): the day's one card, with a 2px rail in its area
// color (a risk hatch in its place when flagged), the release that carried
// it, a 22px headline, the dek and body, where the "why" came from, and the
// people, sessions and diffstat behind it. `e` opens its evidence.
import * as Accordion from "@radix-ui/react-accordion";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { DiffStat, MetaDot } from "../entityDisplay";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { AreaTag, FadeText, People, Provenance, ReleaseTag, SessionPills, StoryEdge, riskLine } from "./StoryParts";
import { useStoryCtx } from "./storyContext";
import { KeyHint } from "./useChangesKeys";

export function LeadStory({ story, open }: { story: StoryRow; open: boolean }) {
  const ctx = useStoryCtx();
  const key = story.story_key;
  const risk = riskLine(story);
  const pending = !story.dek && story.prose_status === "pending";
  const commits = story.commit_shas.length;
  return (
    <Accordion.Item
      value={key}
      data-story-key={key}
      data-flip-key={key}
      data-focused={ctx.focused === key}
      className="chg-story relative scroll-mt-6 overflow-hidden rounded-lg border border-sol-border/25 bg-sol-card px-5 py-4 shadow-sm"
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
      <h2 className="chg-ui mt-2 text-[22px] font-semibold leading-[1.25] text-sol-text [text-wrap:balance]">
        <FadeText text={story.headline} />
      </h2>
      <p className="chg-ui mt-1.5 min-h-[1.6em] text-[15px] leading-[1.6] text-sol-text/80">
        {pending ? <span className="chg-pending-bar" aria-label="Notes pending" /> : <FadeText text={story.dek} />}
      </p>
      {risk && (
        <p className="chg-ui mt-1 flex items-center gap-2 text-[13px] leading-[1.55] text-sol-text/70">
          <span aria-hidden className="chg-hatch h-2.5 w-3.5 shrink-0 rounded-[2px]" />
          {risk}
        </p>
      )}
      {story.body && (
        <p className="chg-ui mt-2 text-[15px] leading-[1.6] text-sol-text/80">
          <FadeText text={story.body} />
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Provenance story={story} />
        <MetaDot />
        <span className="font-mono text-[11px] tabular-nums text-sol-text/55">
          {commits} {commits === 1 ? "commit" : "commits"}
        </span>
        <DiffStat additions={story.insertions} deletions={story.deletions} className="text-[11px]" />
      </div>
      <Accordion.Header asChild>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <People story={story} />
          <SessionPills story={story} />
          <Accordion.Trigger className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-sol-text/60 outline-none transition-colors hover:bg-sol-bg-alt hover:text-sol-text focus-visible:ring-1 focus-visible:ring-sol-border">
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
