// One story inside a section block (spec 4.5): a kind glyph, a 14px headline
// with its diffstat in a fixed column at the right, and the dek under it. The
// whole row is the accordion trigger, so a click anywhere on it opens the
// evidence drawer under it. A flagged story wears the risk hatch on its left
// edge, where its worded risk answers on hover.
import * as Accordion from "@radix-ui/react-accordion";
import type { StoryRow as Story } from "../../hooks/useSyncChanges";
import { DiffStat } from "../entityDisplay";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { FadeText, KindGlyph, RiskSrText, StoryEdge } from "./StoryParts";
import { useStoryAttrs, useStoryCtx } from "./storyContext";

export function StoryRow({ story }: { story: Story }) {
  const ctx = useStoryCtx();
  const key = story.story_key;
  const attrs = useStoryAttrs(key);
  const waiting = ctx.waiting.has(key);
  const pending = !story.dek && story.prose_status === "pending";
  return (
    <Accordion.Item
      value={key}
      {...attrs}
      className="chg-story chg-row relative rounded-md py-1 pl-3 pr-1.5"
      onClick={() => ctx.pick(key)}
    >
      {story.risks.length > 0 && <StoryEdge story={story} />}
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
              <span className="flex w-[5.5rem] shrink-0 justify-end tabular-nums">
                {(story.insertions > 0 || story.deletions > 0) && <DiffStat additions={story.insertions} deletions={story.deletions} themed />}
              </span>
            </span>
            {(pending || story.dek) && (
              <span className="chg-ui line-clamp-2 block pl-5 text-[13px] font-normal leading-[1.55] text-sol-text/70 [overflow-wrap:anywhere]">
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
}
