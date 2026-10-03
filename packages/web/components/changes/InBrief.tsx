// In brief (spec 4.6): the small stories, a line each (two at most), with a dotted leader
// to their area. Each line is still a story: j/k visits it and `e` opens its
// evidence. Each line is its own component, so it can carry the story's hooks.
// The area tags sit in one column, as wide as a section row's size column,
// so their squares line up; the headline starts under the heading, and the
// hover fill bleeds past it.
import * as Accordion from "@radix-ui/react-accordion";
import { memo } from "react";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { AreaTag, FadeText, Tip } from "./StoryParts";
import { useStoryAttrs, useStoryCtx, useTriggerTab } from "./storyContext";

export const InBrief = memo(function InBrief({ stories }: { stories: readonly StoryRow[] }) {
  if (!stories.length) return null;
  return (
    <section aria-label="In brief">
      <h3 className="chg-ui mb-2 text-[13px] font-semibold text-sol-text">In brief</h3>
      <div className="space-y-0.5">
        {stories.map((s) => <BriefItem key={s.story_key} story={s} />)}
      </div>
    </section>
  );
});

const BriefItem = memo(function BriefItem({ story: s }: { story: StoryRow }) {
  const ctx = useStoryCtx();
  const attrs = useStoryAttrs(s.story_key);
  const tab = useTriggerTab(s.story_key);
  return (
    <Accordion.Item
      value={s.story_key}
      {...attrs}
      className="chg-story chg-row -mx-2 rounded-md px-2 py-0.5"
      style={{ opacity: ctx.dimmed.has(s.story_key) ? 0.35 : 1 }}
      onClick={() => ctx.pick(s.story_key)}
    >
      <Accordion.Header asChild>
        <div>
          {/* The whole headline on hover or keyboard focus, only while the line clamp cuts it. */}
          <Tip text={s.headline} whenClipped>
            <Accordion.Trigger data-story-trigger tabIndex={tab} className="flex w-full min-w-0 items-baseline gap-2 text-left outline-none">
              <span data-clip className="chg-ui line-clamp-2 min-w-0 shrink text-[13px] leading-[1.55] text-sol-text/70 [overflow-wrap:anywhere]">
                <FadeText text={s.headline} />
              </span>
              <span aria-hidden className="chg-leader" />
              <span className="w-[5.5rem] shrink-0">
                <AreaTag area={s.area} />
              </span>
            </Accordion.Trigger>
          </Tip>
        </div>
      </Accordion.Header>
      <Accordion.Content className="chg-drawer">
        <EvidenceDrawer story={s} />
      </Accordion.Content>
    </Accordion.Item>
  );
});
