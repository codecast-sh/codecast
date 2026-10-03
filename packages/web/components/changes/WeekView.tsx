// The week view (spec 3, level 4): the week edition's headline and standfirst,
// its five biggest stories, the release ledger, and its seven days as lines
// that open each day, with the week's area bars in the right column. The same
// visual language as the day: the biggest story is the one card, the rest are
// rows, facts are mono. Every story is a link into its day with its evidence
// open. Built only from day editions, stories and the week row (weekModel).
import { ledgerLabel, type LedgerLine } from "@codecast/shared/changes";
import type { StoryRow, WorksRow } from "../../hooks/useSyncChanges";
import { changesDayLabel } from "../../lib/changesDay";
import { DiffStat } from "../entityDisplay";
import { RELEASE_COLOR } from "./areaColor";
import { EditionHead } from "./EditionHead";
import { InTheWorks } from "./InTheWorks";
import { AreaTag, FadeText, KindGlyph, ReleaseTag, RiskSrText, StoryEdge } from "./StoryParts";
import { useStoryAttrs } from "./storyContext";
import type { WeekModel } from "./weekModel";

const rise = (i: number) => ({ ["--i" as any]: Math.min(i, 10) });

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h3 className="chg-ui text-[15px] font-semibold leading-[1.3] text-sol-text">{children}</h3>
      <span aria-hidden className="h-px flex-1 bg-sol-border/15" />
    </div>
  );
}

/** The week's biggest story: the lead card's shape, opening its day. */
function TopCard({ story, onOpen, echo }: { story: StoryRow; onOpen: () => void; echo: boolean }) {
  const attrs = useStoryAttrs(story.story_key);
  // The week headline already says this headline: the card opens with its dek (as the day's lead does).
  const continues = echo && !!story.dek;
  return (
    <button
      type="button"
      onClick={onOpen}
      {...attrs}
      className="chg-story relative block w-full overflow-hidden rounded-lg border border-sol-border/25 bg-sol-card px-5 py-4 text-left shadow-sm transition-colors hover:border-sol-border/50"
    >
      <StoryEdge story={story} />
      <RiskSrText story={story} />
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AreaTag area={story.area} />
        <ReleaseTag story={story} />
        <span className="font-mono text-[11px] text-sol-text/45">{changesDayLabel(story.date)}</span>
      </span>
      <span className={continues ? "sr-only" : "chg-ui mt-2 block text-[22px] font-semibold leading-[1.25] text-sol-text [overflow-wrap:anywhere] [text-wrap:balance]"}>
        <FadeText text={story.headline} />
      </span>
      {story.dek && (
        <span className={`chg-ui block [overflow-wrap:anywhere] ${continues ? "mt-2 text-[17px] font-medium leading-[1.5] text-sol-text" : "mt-1.5 text-[15px] leading-[1.6] text-sol-text/80"}`}>
          <FadeText text={story.dek} />
        </span>
      )}
      <span className="mt-3 flex items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-sol-text/55">
          {story.commit_shas.length} {story.commit_shas.length === 1 ? "commit" : "commits"}
        </span>
        <DiffStat additions={story.insertions} deletions={story.deletions} className="text-[11px]" themed />
      </span>
    </button>
  );
}

/** One of the next four: the section row's shape, with its day where a row has its size. */
function TopRow({ story, onOpen }: { story: StoryRow; onOpen: () => void }) {
  const attrs = useStoryAttrs(story.story_key);
  return (
    <button type="button" onClick={onOpen} {...attrs} className="chg-story chg-row relative block w-full rounded-md py-1 pl-3 pr-1.5 text-left">
      {story.risks.length > 0 && <StoryEdge story={story} />}
      <RiskSrText story={story} />
      <span className="flex min-w-0 items-baseline gap-2">
        <KindGlyph kind={story.kind} />
        <span className="chg-ui line-clamp-3 min-w-0 flex-1 text-[14px] font-medium leading-[1.4] text-sol-text/90 [overflow-wrap:anywhere]">
          <FadeText text={story.headline} />
        </span>
        <AreaTag area={story.area} className="shrink-0 text-[10px]" />
        <span className="w-[5.5rem] shrink-0 text-right font-mono text-[10px] tabular-nums text-sol-text/45">{changesDayLabel(story.date)}</span>
      </span>
      {story.dek && (
        <span className="chg-ui line-clamp-2 block pl-5 text-[13px] leading-[1.55] text-sol-text/70 [overflow-wrap:anywhere]">
          <FadeText text={story.dek} />
        </span>
      )}
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
            {l.count} {l.count === 1 ? "release" : "releases"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WeekView({ week, works, today, reserve, animate, onDay, onStory, onClearFilters }: {
  week: WeekModel;
  works: readonly WorksRow[];
  today: string;
  /** Keep the standfirst's height while the week's prose may still arrive. */
  reserve: boolean;
  /** The first paint's stagger (spec 5.4); off while a week slides in. */
  animate: boolean;
  onDay: (day: string) => void;
  /** Open a story in its day, its evidence drawer open. */
  onStory: (day: string, storyKey: string) => void;
  onClearFilters: () => void;
}) {
  const motion = (i: number) => (animate ? { className: "chg-rise", style: rise(i) } : { className: "", style: undefined });
  const [lead, ...rest] = week.top;
  const thisWeek = week.days.some((d) => d.date === today);
  const quiet = week.stories.length === 0;
  return (
    <div className="chg-grid mt-7">
      <div className={`chg-span-12 ${motion(0).className}`} style={motion(0).style}>
        {quiet ? (
          <h2 className="chg-headline text-sol-text/80">Nothing landed on main {thisWeek ? "this week yet" : "this week"}.</h2>
        ) : (
          <EditionHead headline={week.headline} standfirst={week.standfirst} reserve={reserve} filterLine={week.filterLine} onClear={onClearFilters} />
        )}
      </div>

      <div className="chg-span-8 grid grid-cols-[minmax(0,1fr)] content-start gap-7">
        {!quiet && week.matching === 0 && week.filterLine && (
          <div className="rounded-lg border border-dashed border-sol-border/40 px-5 py-8 text-center">
            <p className="chg-ui text-[14px] text-sol-text/70">No stories this week match these filters.</p>
            <button type="button" onClick={onClearFilters} className="mt-2 font-mono text-[11px] text-sol-text/60 underline-offset-2 hover:text-sol-text hover:underline">
              clear filters
            </button>
          </div>
        )}
        {lead && (
          <section aria-label="The week's biggest stories" className={motion(2).className} style={motion(2).style}>
            <TopCard story={lead} echo={week.leadEchoesHeadline} onOpen={() => onStory(lead.date, lead.story_key)} />
            {rest.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {rest.map((s) => <TopRow key={s.story_key} story={s} onOpen={() => onStory(s.date, s.story_key)} />)}
              </div>
            )}
          </section>
        )}

        {week.ledger.length > 0 && (
          <section className={motion(3).className} style={motion(3).style}>
            <SectionTitle>Releases</SectionTitle>
            <Ledger lines={week.ledger} />
          </section>
        )}

        <section className={motion(5).className} style={motion(5).style}>
          <SectionTitle>Day by day</SectionTitle>
          <div className="space-y-0.5">
            {week.days.map((d) => (
              <button
                key={d.date}
                type="button"
                onClick={() => onDay(d.date)}
                title={d.quiet ? undefined : d.headline}
                className="grid w-full grid-cols-[6.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sol-bg-alt/60"
              >
                <span className="font-mono text-[12px] leading-5 tabular-nums text-sol-text/55">{changesDayLabel(d.date)}</span>
                <span className={`chg-ui line-clamp-3 text-[14px] leading-5 ${d.quiet ? "text-sol-text/40" : "font-medium text-sol-text/90"}`}>
                  {d.quiet ? (d.date === today ? "Nothing landed yet" : "Nothing landed") : d.headline}
                </span>
                <span className="font-mono text-[10px] leading-5 tabular-nums text-sol-text/45">{d.quiet ? "" : `${d.commits} ${d.commits === 1 ? "commit" : "commits"}`}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <aside className={`chg-works ${motion(4).className}`} style={motion(4).style} aria-label="In the works">
        <InTheWorks works={works} areas={week.areas} areasLabel={thisWeek ? "Areas this week" : "Areas that week"} live={thisWeek} viewed="this week" />
      </aside>
    </div>
  );
}
