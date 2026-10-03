// One area's block (spec 4.5): the area name, a hairline and a count, then its
// stories in the order they landed with release stamps between them. Blocks
// are independent grid cells, so expanding a row never rebalances the page and
// j/k order is the DOM order. An area filter that misses the whole block
// folds it to its header, with how many of its stories match.
import { memo } from "react";
import type { StoryRow as Story } from "../../hooks/useSyncChanges";
import { areaLabel } from "./areaColor";
import type { Section } from "./editionModel";
import { ReleaseStamp } from "./ReleaseStamp";
import { AreaDot } from "./StoryParts";
import { StoryRow } from "./StoryRow";

export const SectionBlock = memo(function SectionBlock({ section, stories, collapsed = false }: {
  section: Section;
  stories: readonly Story[];
  /** An area filter misses every story here while others match: only the header stays, so the matches rise. */
  collapsed?: boolean;
}) {
  return (
    <section
      className="min-w-0 transition-opacity duration-200 motion-reduce:transition-none"
      style={{ opacity: collapsed ? 0.5 : section.dimmed ? 0.35 : 1 }}
      aria-label={areaLabel(section.area)}
    >
      {/* The square sits in a slot as wide as a row's kind glyph, so the area name starts where the row titles do. */}
      <header className={`flex items-center gap-2 pl-3 ${collapsed ? "" : "mb-1.5"}`}>
        <span className="inline-flex w-3 shrink-0 justify-center"><AreaDot area={section.area} /></span>
        <h3 className="chg-ui text-[15px] font-semibold leading-[1.3] text-sol-text">{areaLabel(section.area)}</h3>
        <span className="h-px flex-1 bg-sol-border/15" />
        <span className="font-mono text-[11px] tabular-nums text-sol-text/45">{collapsed ? `0 of ${section.count} match` : section.count}</span>
      </header>
      {!collapsed && (
        <div className="space-y-1.5">
          {section.items.map((item) =>
            item.kind === "story"
              ? <StoryRow key={item.story.story_key} story={item.story} />
              : <ReleaseStamp key={item.key} ship={item.ship} stories={stories} />,
          )}
        </div>
      )}
    </section>
  );
});
