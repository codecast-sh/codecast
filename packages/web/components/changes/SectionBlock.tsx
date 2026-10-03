// One area's block (spec 4.5): the area name, a hairline and a count, then its
// stories in the order they landed with release stamps between them. Blocks
// are independent grid cells, so expanding a row never rebalances the page and
// j/k order is the DOM order. An area filter that misses the block dims it.
import type { StoryRow as Story } from "../../hooks/useSyncChanges";
import { areaColor } from "./areaColor";
import type { Section } from "./editionModel";
import { ReleaseStamp } from "./ReleaseStamp";
import { StoryRow } from "./StoryRow";

export function SectionBlock({ section, stories }: { section: Section; stories: readonly Story[] }) {
  return (
    <section
      className="min-w-0 transition-opacity duration-200 motion-reduce:transition-none"
      style={{ opacity: section.dimmed ? 0.35 : 1 }}
      aria-label={section.area}
    >
      <header className="mb-1.5 flex items-center gap-2.5">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: areaColor(section.area) }} />
        <h3 className="chg-ui text-[15px] font-semibold leading-[1.3] text-sol-text">{section.area}</h3>
        <span className="h-px flex-1 bg-sol-border/15" />
        <span className="font-mono text-[11px] tabular-nums text-sol-text/45">{section.count}</span>
      </header>
      <div className="space-y-1.5">
        {section.items.map((item) =>
          item.kind === "story"
            ? <StoryRow key={item.story.story_key} story={item.story} />
            : <ReleaseStamp key={item.key} ship={item.ship} stories={stories} />,
        )}
      </div>
    </section>
  );
}
