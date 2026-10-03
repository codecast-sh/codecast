// In brief (spec 4.6): the small stories, a line each (two at most), with a dotted leader
// to their area. Each line is still a story: j/k visits it and `e` opens its
// evidence. Each line is its own component, so it can carry the story's hooks.
import * as Accordion from "@radix-ui/react-accordion";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { AreaTag, FadeText, Tip } from "./StoryParts";
import { useStoryAttrs, useStoryCtx } from "./storyContext";

export function InBrief({ stories }: { stories: readonly StoryRow[] }) {
  if (!stories.length) return null;
  return (
    <section aria-label="In brief">
      <h3 className="chg-ui mb-2 text-[13px] font-semibold text-sol-text">In brief</h3>
      <div className="space-y-0.5">
        {stories.map((s) => <BriefItem key={s.story_key} story={s} />)}
      </div>
    </section>
  );
}

function BriefItem({ story: s }: { story: StoryRow }) {
  const ctx = useStoryCtx();
  const attrs = useStoryAttrs(s.story_key);
  return (
    <Accordion.Item
      value={s.story_key}
      {...attrs}
      className="chg-story chg-row rounded-md px-2 py-0.5"
      style={{ opacity: ctx.dimmed.has(s.story_key) ? 0.35 : 1 }}
      onClick={() => ctx.pick(s.story_key)}
    >
      <Accordion.Header asChild>
        <div>
          <Accordion.Trigger data-story-trigger className="flex w-full min-w-0 items-center gap-2 text-left outline-none">
            <Tip text={s.headline} whenClipped>
              <span className="chg-ui line-clamp-2 min-w-0 shrink text-[13px] leading-[1.55] text-sol-text/70 [overflow-wrap:anywhere]">
                <FadeText text={s.headline} />
              </span>
            </Tip>
            <span aria-hidden className="chg-leader" />
            <AreaTag area={s.area} className="shrink-0" />
          </Accordion.Trigger>
        </div>
      </Accordion.Header>
      <Accordion.Content className="chg-drawer">
        <EvidenceDrawer story={s} />
      </Accordion.Content>
    </Accordion.Item>
  );
}
