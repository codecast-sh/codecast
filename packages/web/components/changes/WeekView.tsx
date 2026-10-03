// The week view (spec 3, level 4): the week edition's headline and standfirst,
// its five biggest stories, the release ledger, and its seven days as lines
// that open each day, with the week's area bars in the right column. The same
// visual language as the day: the biggest story is the one card, the rest are
// rows, facts are mono. Every story is a link into its day with its evidence
// open. Built only from day editions, stories and the week row (weekModel).
import { useRef } from "react";
import { leadSentences, ledgerLabel, type LedgerLine } from "@codecast/shared/changes";
import type { StoryRow, WorksRow } from "../../hooks/useSyncChanges";
import { changesDayLabel } from "../../lib/changesDay";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { DiffStat } from "../entityDisplay";
import { ink, RELEASE_COLOR } from "./areaColor";
import { EditionHead } from "./EditionHead";
import { nothingLanded, plural, rise } from "./format";
import { InTheWorks } from "./InTheWorks";
import { AreaTag, CARD_BODY, CARD_LEDE, FadeText, KindGlyph, NoMatch, ReleaseTag, RiskLine, RiskSrText, StoryEdge, storyOpener } from "./StoryParts";
import { useStoryAttrs } from "./storyContext";
import type { WeekModel } from "./weekModel";

/** Words of the week's standfirst the head keeps, so the biggest story stays above the fold; the rest follows the biggest stories. */
const STANDFIRST_WORDS = 60;

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h3 className="chg-ui text-[15px] font-semibold leading-[1.3] text-sol-text">{children}</h3>
      <span aria-hidden className="h-px flex-1 bg-sol-border/15" />
    </div>
  );
}

/**
 * The week's biggest story: the lead card's shape, opening its day. Under its
 * headline it opens with the first sentences of its body, not its dek, which
 * would say the headline again under a week headline that often already has,
 * set as the day's lead sets it; then every one of its risks in words.
 */
function TopCard({ story, onOpen, echo }: { story: StoryRow; onOpen: () => void; echo: boolean }) {
  const attrs = useStoryAttrs(story.story_key);
  const opener = storyOpener(story).text;
  // The week headline already says this headline: the card opens with its prose (as the day's lead does).
  const continues = echo && !!opener;
  return (
    <button
      type="button"
      onClick={onOpen}
      {...attrs}
      className="chg-story relative block w-full overflow-hidden rounded-lg border border-sol-border/25 bg-sol-card px-5 py-4 text-left shadow-sm transition-colors hover:border-sol-border/50"
    >
      <StoryEdge story={story} />
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AreaTag area={story.area} />
        <ReleaseTag story={story} />
        <span className="font-mono text-[11px] text-sol-text/45">{changesDayLabel(story.date)}</span>
      </span>
      <span className={continues ? "sr-only" : "chg-ui mt-2 block text-[22px] font-semibold leading-[1.25] text-sol-text [overflow-wrap:anywhere] [text-wrap:pretty]"}>
        <FadeText text={story.headline} />
      </span>
      {opener && (
        <span className={`block ${continues ? CARD_LEDE : `mt-1.5 ${CARD_BODY}`}`}>
          <FadeText text={opener} />
        </span>
      )}
      <RiskLine story={story} full className="mt-2" />
      <span className="mt-3 flex items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-sol-text/55">
          {plural(story.commit_shas.length, "commit")}
        </span>
        <DiffStat additions={story.insertions} deletions={story.deletions} className="text-[11px]" themed />
      </span>
    </button>
  );
}

/** One of the next four: the section row's shape, with its day and area in the column where a row has its size. */
function TopRow({ story, onOpen }: { story: StoryRow; onOpen: () => void }) {
  const attrs = useStoryAttrs(story.story_key);
  return (
    <button type="button" onClick={onOpen} {...attrs} className="chg-story chg-row relative block w-full cursor-pointer rounded-md py-1 pl-3 pr-1.5 text-left">
      {story.risks.length > 0 && <StoryEdge story={story} compact />}
      <RiskSrText story={story} />
      {/* The meta column stands beside the headline and the dek, so a one-line headline keeps its dek right under it. */}
      <span className="flex min-w-0 items-baseline gap-2">
        <KindGlyph kind={story.kind} />
        <span className="block min-w-0 flex-1">
          <span className="chg-ui line-clamp-3 text-[14px] font-medium leading-[1.4] text-sol-text/90 [overflow-wrap:anywhere]">
            <FadeText text={story.headline} />
          </span>
          {story.dek && (
            <span className="chg-ui line-clamp-2 block text-[13px] leading-[1.55] text-sol-text/70 [overflow-wrap:anywhere]">
              <FadeText text={story.dek} />
            </span>
          )}
          <RiskLine story={story} className="mt-1" />
        </span>
        <span className="flex w-[5.5rem] shrink-0 flex-col items-end gap-0.5">
          <span className="font-mono text-[10px] tabular-nums text-sol-text/45">{changesDayLabel(story.date)}</span>
          <AreaTag area={story.area} className="text-[10px]" />
        </span>
      </span>
    </button>
  );
}

/** "cli  1.1.157 to 1.1.163 ........ 7 releases", in the stamp's green. */
function Ledger({ lines }: { lines: readonly LedgerLine[] }) {
  return (
    <ul className="space-y-1" aria-label="Release ledger">
      {lines.map((l) => (
        <li key={l.surface} className="flex items-center gap-2 px-2" title={ledgerLabel(l)}>
          <AreaTag area={l.surface} className="w-[5.5rem] shrink-0" />
          <span className="font-mono text-[12px] tabular-nums text-sol-text/85">
            {l.count > 1 && l.first !== l.last ? <>{l.first} <span className="text-sol-text/45">to</span> {l.last}</> : l.last}
          </span>
          <span aria-hidden className="chg-leader" />
          <span
            className="shrink-0 rounded-full border px-2 py-[1px] font-mono text-[10px] tabular-nums text-sol-text/75"
            style={{ borderColor: RELEASE_COLOR }}
          >
            {plural(l.count, "release")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WeekView({ week, works, today, branches, reserve, animate, slide, activeAreas, onArea, onDay, onStory, onClearFilters }: {
  week: WeekModel;
  /** The branch toggle: with every branch shown, an empty week is not "on main". */
  branches?: string;
  works: readonly WorksRow[];
  today: string;
  /** Keep the standfirst's height while the week's prose may still arrive. */
  reserve: boolean;
  /** The first paint's stagger (spec 5.4); off while a week slides in. */
  animate: boolean;
  /** The week being travelled to: its head and main column slide in under this key, the rail stays still. */
  slide?: { key: string; className: string };
  /** The area filter, which the rail's area bars toggle. */
  activeAreas?: readonly string[];
  onArea?: (area: string) => void;
  onDay: (day: string) => void;
  /** Open a story in its day, its evidence drawer open. */
  onStory: (day: string, storyKey: string) => void;
  onClearFilters: () => void;
}) {
  const motion = (i: number) => (animate ? { className: "chg-rise", style: rise(i) } : { className: "", style: undefined });
  const [lead, ...rest] = week.top;
  const standfirst = week.standfirst ? leadSentences(week.standfirst, STANDFIRST_WORDS) : null;
  const thisWeek = week.days.some((d) => d.date === today);
  const quiet = week.stories.length === 0;
  const slideClass = slide?.className ?? "";
  // A filter that matches none of the week's stories leaves nothing for the
  // summary to close: the head keeps all of it, above the No-match card.
  const emptied = !lead && week.matching !== week.stories.length;
  // The standfirst's remainder: the summary stays whole, read on past the
  // stories it names, and closes them as a note under a hairline, in line
  // with the rows' deks. With no stories to close it reads as the head's own paragraph.
  const remainder = standfirst?.rest && !emptied && (lead ? (
    <p className="chg-ui chg-lead-prose ml-8 mt-5 border-t border-sol-border/15 pt-3 text-[13px] leading-[1.55]" style={{ color: ink(70) }}>
      <FadeText text={standfirst.rest} />
    </p>
  ) : (
    <p className={`chg-ui chg-lead-prose text-[15px] leading-[1.6] ${motion(2).className}`} style={{ ...motion(2).style, color: ink(80) }}>
      <FadeText text={standfirst.rest} />
    </p>
  ));
  // Every story of the week has a home: the biggest are here, the rest are in their days below.
  const dayByDay = useRef<HTMLElement>(null);
  // The stories the filters match past the biggest ones, not the whole week's.
  const more = week.matching - week.top.length;
  return (
    <div className="chg-grid mt-7">
      <div key={`head-${slide?.key ?? ""}`} className={`chg-span-12 ${slideClass} ${motion(0).className}`} style={motion(0).style}>
        {quiet ? (
          <h2 className="chg-headline text-sol-text/80">{nothingLanded(branches, "this week", thisWeek)}</h2>
        ) : (
          <EditionHead headline={week.headline} standfirst={(emptied ? week.standfirst : standfirst?.lead) ?? null} reserve={reserve} filterLine={week.filterLine} onClear={onClearFilters} />
        )}
      </div>

      <div key={`main-${slide?.key ?? ""}`} className={`chg-span-8 grid grid-cols-[minmax(0,1fr)] content-start gap-7 ${slideClass}`}>
        {!quiet && week.matching === 0 && week.filterLine && (
          <NoMatch what="stories this week" onClear={onClearFilters} />
        )}
        {lead && (
          <section aria-label="The week's biggest stories" className={motion(2).className} style={motion(2).style}>
            <TopCard story={lead} echo={week.leadEchoesHeadline} onOpen={() => onStory(lead.date, lead.story_key)} />
            {rest.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {rest.map((s) => <TopRow key={s.story_key} story={s} onOpen={() => onStory(s.date, s.story_key)} />)}
              </div>
            )}
            {more > 0 && (
              <button
                type="button"
                onClick={() => dayByDay.current?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" })}
                className="ml-8 mt-2 rounded-sm font-mono text-[12px] underline-offset-2 transition-colors hover:text-sol-text hover:underline"
                style={{ color: ink(55) }}
              >
                {plural(more, "more story", "more stories")}, by day
              </button>
            )}
            {remainder}
          </section>
        )}
        {!lead && remainder}

        {week.ledger.length > 0 && (
          <section className={motion(3).className} style={motion(3).style}>
            <SectionTitle>Releases</SectionTitle>
            <Ledger lines={week.ledger} />
          </section>
        )}

        <section ref={dayByDay} className={`scroll-mt-6 ${motion(5).className}`} style={motion(5).style}>
          <SectionTitle>Day by day</SectionTitle>
          <div className="space-y-0.5">
            {week.days.map((d) => (
              <button
                key={d.date}
                type="button"
                onClick={() => onDay(d.date)}
                title={d.quiet ? undefined : d.headline}
                className="grid w-full grid-cols-[6.5rem_minmax(0,1fr)_5.5rem] items-start gap-3 rounded-md py-1.5 pl-2 pr-1.5 text-left transition-colors hover:bg-sol-bg-alt/60"
              >
                <span className="font-mono text-[12px] leading-5 tabular-nums text-sol-text/55">{changesDayLabel(d.date)}</span>
                <span className={`chg-ui line-clamp-3 text-[14px] leading-5 ${d.quiet ? "text-sol-text/40" : "font-medium text-sol-text/90"}`}>
                  {d.quiet ? (d.date === today ? "Nothing landed yet" : "Nothing landed") : d.headline}
                </span>
                <span className="text-right font-mono text-[10px] leading-5 tabular-nums text-sol-text/45">{d.quiet ? "" : plural(d.stories, "story", "stories")}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <aside className={`chg-works ${motion(4).className}`} style={motion(4).style} aria-label="In the works">
        <InTheWorks works={works} areas={week.areas} areasLabel={thisWeek ? "Areas this week" : "Areas that week"} live={thisWeek} viewed={`the week of ${changesDayLabel(week.days[0]?.date)}`} activeAreas={activeAreas} onArea={onArea} />
      </aside>
    </div>
  );
}
