// One story inside a section block (spec 4.5): a kind glyph, a 14px headline
// with its insertions at the right, and the dek on a second line that is
// always rendered, so opening or focusing a row never shifts the page. The
// row is an accordion item; its evidence drawer opens under it.
import * as Accordion from "@radix-ui/react-accordion";
import type { StoryRow as Story } from "../../hooks/useSyncChanges";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { FadeText, KindGlyph, StoryEdge, Tip, riskText } from "./StoryParts";
import { useStoryCtx } from "./storyContext";

export function StoryRow({ story }: { story: Story }) {
  const ctx = useStoryCtx();
  const key = story.story_key;
  const focused = ctx.focused === key;
  const waiting = ctx.waiting.has(key);
  const pending = !story.dek && story.prose_status === "pending";
  return (
    <Accordion.Item
      value={key}
      data-story-key={key}
      data-flip-key={key}
      data-focused={focused}
      className="chg-story relative scroll-mt-6 rounded-md py-1 pl-3 pr-1.5"
      onClick={() => ctx.pick(key)}
    >
      {story.risks.length > 0 && <StoryEdge story={story} />}
      <Accordion.Header asChild>
        <div>
          <Accordion.Trigger className="flex w-full min-w-0 items-baseline gap-2 text-left outline-none">
            <KindGlyph kind={story.kind} />
            <span className="chg-ui line-clamp-2 min-w-0 flex-1 text-[14px] font-medium leading-[1.4] text-sol-text/90">
              <FadeText text={story.headline} />
            </span>
            {waiting && <span className="shrink-0 font-mono text-[10px] text-sol-text/45">waiting</span>}
            {story.risks.length > 0 && (
              <Tip text={<span className="whitespace-pre-line">{riskText(story)}</span>}>
                <span className="chg-hatch h-2.5 w-3.5 shrink-0 self-center rounded-[2px]" aria-label="Risk" />
              </Tip>
            )}
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-sol-text/45">
              {story.insertions > 0 ? `+${story.insertions.toLocaleString()}` : story.deletions > 0 ? `-${story.deletions.toLocaleString()}` : ""}
            </span>
          </Accordion.Trigger>
        </div>
      </Accordion.Header>
      <p className="chg-ui min-h-[1.55em] truncate pl-5 text-[13px] leading-[1.55] text-sol-text/70">
        {pending ? <span className="chg-pending-bar" aria-label="Notes pending" /> : <FadeText text={story.dek} />}
      </p>
      <Accordion.Content className="chg-drawer pl-5">
        <EvidenceDrawer story={story} />
      </Accordion.Content>
    </Accordion.Item>
  );
}
