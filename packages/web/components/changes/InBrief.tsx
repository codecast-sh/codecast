// In brief (spec 4.6): the small stories, one line each, with a dotted leader
// to their area. Each line is still a story: j/k visits it and `e` opens its
// evidence.
import * as Accordion from "@radix-ui/react-accordion";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { AreaTag, FadeText, useStoryCtx } from "./StoryParts";

export function InBrief({ stories }: { stories: readonly StoryRow[] }) {
  const ctx = useStoryCtx();
  if (!stories.length) return null;
  return (
    <section aria-label="In brief">
      <h3 className="chg-ui mb-2 text-[13px] font-semibold text-sol-text">In brief</h3>
      <div className="space-y-0.5">
        {stories.map((s) => (
          <Accordion.Item
            key={s.story_key}
            value={s.story_key}
            data-story-key={s.story_key}
            data-flip-key={s.story_key}
            data-focused={ctx.focused === s.story_key}
            className="chg-story scroll-mt-6 rounded-md px-2 py-0.5"
            style={{ opacity: ctx.dimmed.has(s.story_key) ? 0.35 : 1 }}
            onClick={() => ctx.pick(s.story_key)}
          >
            <Accordion.Header asChild>
              <div>
                <Accordion.Trigger className="flex w-full min-w-0 items-center gap-2 text-left outline-none">
                  <span className="chg-ui min-w-0 shrink truncate text-[13px] leading-[1.55] text-sol-text/70">
                    <FadeText text={s.headline} />
                  </span>
                  <span aria-hidden className="chg-leader" />
                  <AreaTag area={s.area} className="shrink-0" />
                </Accordion.Trigger>
              </div>
            </Accordion.Header>
            <Accordion.Content className="chg-drawer">
              <EvidenceDrawer story={s} />
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </div>
    </section>
  );
}
