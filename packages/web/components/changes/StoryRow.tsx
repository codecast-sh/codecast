// One story on the timeline: a kind glyph, the headline with its size in a
// fixed column at the right, and the dek under it. The size is one muted
// number, lines added, so a column of rows reads as text, not a chart. The
// whole row is the accordion trigger: a click anywhere on it opens the story
// under it, where its body, its why, its worded risks and its evidence live.
// Risks are read there too, or through the risk filter: on a row they were noise.
import * as Accordion from "@radix-ui/react-accordion";
import { memo } from "react";
import type { StoryRow as Story } from "../../hooks/useSyncChanges";
import { ink } from "./areaColor";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { FadeText, KindGlyph, RiskSrText } from "./StoryParts";
import { useStoryAttrs, useStoryCtx } from "./storyContext";

export const StoryRow = memo(function StoryRow({ story }: { story: Story }) {
  const ctx = useStoryCtx();
  const key = story.story_key;
  const attrs = useStoryAttrs(key);
  const waiting = ctx.waiting.has(key);
  // The pending bar holds the dek's place only while notes can still come.
  const pending = !story.dek && story.prose_status === "pending" && !!ctx.proseLive;
  return (
    <Accordion.Item
      value={key}
      {...attrs}
      className="chg-story chg-row group relative rounded-md py-1 pl-3 pr-1.5"
      onClick={() => ctx.pick(key)}
    >
      <Accordion.Header asChild>
        <div>
          <Accordion.Trigger data-story-trigger className="flex w-full min-w-0 flex-col text-left outline-none">
            <span className="flex w-full min-w-0 items-baseline gap-2">
              <KindGlyph kind={story.kind} />
              <span className="chg-ui line-clamp-3 min-w-0 flex-1 text-[14px] font-medium leading-[1.4] text-sol-text/90 [overflow-wrap:anywhere]">
                <FadeText text={story.headline} />
              </span>
              {waiting && <span className="shrink-0 font-mono text-[10px] text-sol-text/45">waiting</span>}
              <RiskSrText story={story} />
              {/* The column keeps its width with nothing in it, so sizes line up down the block. */}
              <span
                className="w-[5.5rem] shrink-0 text-right font-mono text-[10px] tabular-nums"
                style={{ color: ink(40) }}
                title={`+${story.insertions.toLocaleString()} -${story.deletions.toLocaleString()} lines`}
              >
                {/* A story that only removed lines says so instead of standing blank. */}
                {story.insertions > 0 ? `+${story.insertions.toLocaleString()}` : story.deletions > 0 ? `-${story.deletions.toLocaleString()}` : ""}
              </span>
            </span>
            {(pending || story.dek) && (
              <span className="chg-ui line-clamp-1 block pl-5 text-[13px] font-normal leading-[1.55] text-sol-text/60 [overflow-wrap:anywhere] group-data-[state=open]:line-clamp-none">
                {pending ? <span className="chg-pending-bar" role="img" aria-label="Notes pending" /> : <FadeText text={story.dek} />}
              </span>
            )}
          </Accordion.Trigger>
        </div>
      </Accordion.Header>
      <Accordion.Content className="chg-drawer pl-5">
        <EvidenceDrawer story={story} />
      </Accordion.Content>
    </Accordion.Item>
  );
});
