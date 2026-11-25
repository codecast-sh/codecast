"use client";
// /changes: one timeline of what the team shipped, newest day first
// (docs/proposals/changes-page.md). The route (app/changes/page) holds the
// team and feature gates; this page reads the store only. The newest week is
// fed by useSyncChangesTimeline, and each older week by a ChangesChunkFeed the
// page mounts as the reader scrolls to it.
//
// One feed to skim, any change a click deep: each day opens with its
// sentence, then its changes as cards (StoryEntry: headline, dek, who, when,
// a thumbnail) heaviest first, then its small changes one line each. A card
// opens in place to its screens, article and evidence; one at a time, named
// in the URL. A finished week's notes sit where the timeline enters the week. Filters, the work in progress and what
// is live stay in the header.
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isoWeekOf, weekMonday } from "@codecast/shared/changes";
import { normalizeRepository } from "@codecast/shared/contracts";
import { localDate, normalizeTimezone } from "@codecast/convex/convex/lib/teamDay";
import {
  ChangesChunkFeed,
  recentWindow,
  timelineChunk,
  useChangeEditions,
  useChangeLive,
  useChangeStories,
  useChangeWorks,
  useSyncChangesTimeline,
  type StoryRow as Story,
} from "../../hooks/useSyncChanges";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useRepositories } from "../../hooks/useRepoBrowse";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useTabActive } from "../../hooks/usePagePresence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { copyText } from "../../lib/copyText";
import { memberDisplayName } from "../../lib/liveEntities";
import { isConvexId, useInboxStore } from "../../store/inboxStore";
import { TooltipProvider } from "../ui/tooltip";
import { TimelineHeader, TimelineWorks, type FilterOptions } from "./ChangesHeader";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { assignAreaColors } from "./areaColor";
import { nameOfPerson, peopleOf, personFor } from "./editionModel";
import { plural } from "./format";
import { NoMatch, clockOf } from "./StoryParts";
import { StoryEntry } from "./StoryEntry";
import { StoryCtx, createFocusStore, type StoryContext } from "./storyContext";
import { storyTargetHref } from "./storyTarget";
import { buildTimeline, groupWeeks, type TimelineDay, type TimelineWeek } from "./timelineModel";
import { escapeStep, keepsOwnEnter, useChangesKeys } from "./useChangesKeys";
import { EMPTY_URL, changesHref, clearFilters, hasFilters, useChangesUrlState } from "./useChangesUrlState";
import { useMountEffect } from "../../hooks/useMountEffect";
import { modernButton } from "../ui/modernLook";

const releaseName = (r: { surface: string; version?: string; sha: string }) => `${r.surface} ${r.version ?? r.sha.slice(0, 7)}`;

function Skeleton() {
  const bar = (w: string, h: number, mt = 0) => <div className="rounded bg-sol-bg-alt/70" style={{ width: w, height: h, marginTop: mt }} />;
  return (
    <div className="mt-8 animate-pulse motion-reduce:animate-none" role="status" aria-busy="true">
      <span className="sr-only">Loading changes</span>
      {[0, 1].map((d) => (
        <div key={d} className="mb-10">
          {bar("18%", 11)}
          {bar("62%", 16, 10)}
          {[0, 1, 2].map((i) => <div key={i} className="mt-4">{bar(`${56 - i * 7}%`, 13)}{bar(`${72 - i * 6}%`, 11, 6)}</div>)}
        </div>
      ))}
    </div>
  );
}

/** The day's sentence and its few sentences of story, under the date. */
function DayHead({ day, meta }: { day: TimelineDay; meta: string }) {
  return (
    <>
      {day.summary && <p className="chg-ui text-[19px] font-bold leading-[1.3] tracking-tight text-sol-text [overflow-wrap:anywhere]">{day.summary}</p>}
      {day.standfirst && <p className="chg-ui mt-2 max-w-[44rem] text-[14.5px] leading-[1.65] text-sol-text/75 [overflow-wrap:anywhere]">{day.standfirst}</p>}
      <p className={`font-mono text-meta tabular-nums text-sol-text-dim ${day.summary ? "mt-2.5" : ""}`}>{meta}</p>
    </>
  );
}

/** One day: its sentence, its changes as cards heaviest first, then its small changes a line each. */
function DaySection({ day, today }: { day: TimelineDay; today: string }) {
  const label = day.date === today ? "Today" : changesDayLabel(day.date);
  const count = day.stories.length + day.small.length;
  const meta = [
    count < day.total ? `${count} of ${day.total} changes` : plural(count, "change"),
    ...day.releases.map((r) => `${releaseName(r)} ${(r.kind ?? (r.version ? "release" : "deploy")) === "deploy" ? "deployed" : "released"} ${clockOf(r.at)}`),
  ].join(" · ");
  return (
    <section className="chg-day grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 border-t border-sol-border/20 pb-4 pt-7 first:border-t-0" aria-label={label ?? day.date}>
      <h2 className="sticky top-3 self-start pt-1.5 font-mono text-[12px] tabular-nums text-sol-text-muted">{label}</h2>
      <div className="min-w-0">
        <DayHead day={day} meta={meta} />
        <div className="mt-3">
          {day.stories.map((s) => <StoryEntry key={s.story_key} story={s} />)}
        </div>
        {day.small.length > 0 && (
          <div className={day.stories.length ? "mt-3 border-t border-sol-border/15 pt-2" : "mt-2"}>
            {day.small.map((s) => <StoryEntry key={s.story_key} story={s} small />)}
          </div>
        )}
      </div>
    </section>
  );
}

/** A finished week's notes, where the timeline enters the week: its headline and what it adds up to. */
function WeekSummary({ week, label }: { week: TimelineWeek; label: string }) {
  return (
    <section className="chg-week grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 border-t border-sol-border/20 pt-7 first:border-t-0" aria-label={label}>
      <h2 className="sticky top-3 self-start pt-1 font-mono text-[12px] text-sol-text-muted">{label}</h2>
      <div className="min-w-0 rounded-lg bg-sol-bg-alt/50 px-5 py-4">
        <p className="chg-ui text-[17px] font-bold leading-[1.3] tracking-tight text-sol-text [overflow-wrap:anywhere]">{week.headline}</p>
        {week.summary && <p className="chg-ui mt-2 max-w-[44rem] text-[14px] leading-[1.65] text-sol-text/75 [overflow-wrap:anywhere]">{week.summary}</p>}
      </div>
    </section>
  );
}

/** The calendar day `days` from `day` (YYYY-MM-DD), free of any clock or zone. */
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const weekLabel = (week: string) => {
  const monday = weekMonday(week);
  return monday ? `Week of ${changesDayLabel(monday)}` : week;
};

/** Calls `onReach` whenever the element scrolls into view (or near it). */
function useReach(onReach: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const reach = useRef(onReach);
  reach.current = onReach;
  useMountEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && reach.current(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  });
  return ref;
}

/** How far back the timeline reaches, in chunks, before the reader has to ask. */
const MAX_CHUNKS = 26;

export function ChangesPage() {
  const router = useRouter();
  const { url, setUrl } = useChangesUrlState();
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id as string | undefined);
  const timezone = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId))?.timezone as string | undefined);
  const now = useCoarseNow(60_000);
  const today = timezone ? localDate(now, normalizeTimezone(timezone)) : localDay(0, now);
  const [chunks, setChunks] = useState(1);

  // ── Repository ──────────────────────────────────────────────────────────
  // Every repository is ranked by its commits in the last 14 days of
  // editions, whichever part of the timeline is on screen. The default is
  // written into the URL once, so nothing arriving later moves the page.
  const recentEditions = useChangeEditions(teamId, undefined, useMemo(() => recentWindow(today), [today]));
  const teamRepos = useRepositories();
  const knownRepo = useMemo(
    () => teamRepos.rows.filter((r) => String(r.team_id) === teamId).map((r) => normalizeRepository(r.repository)).sort()[0],
    [teamRepos.rows, teamId],
  );
  const repos = useMemo(() => {
    const commits = new Map<string, number>();
    for (const e of recentEditions) if (e.repository) commits.set(e.repository, (commits.get(e.repository) ?? 0) + (e.stats?.commits ?? 0));
    return [...commits].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo, n]) => ({ repo, commits: n }));
  }, [recentEditions]);
  // A repository the team does not have (a link from another team, or the
  // page kept open across a team switch) reads as the team's default, never
  // as an empty timeline.
  const teamRepoSet = useMemo(
    () => new Set([...repos.map((r) => r.repo), ...teamRepos.rows.filter((r) => String(r.team_id) === teamId).map((r) => normalizeRepository(r.repository))]),
    [repos, teamRepos.rows, teamId],
  );
  const urlRepo = url.repo ? normalizeRepository(url.repo) : undefined;
  const foreign = !!urlRepo && teamRepoSet.size > 0 && !teamRepoSet.has(urlRepo);
  const feed = useSyncChangesTimeline({ teamId, repository: foreign ? undefined : urlRepo, today, chunks });
  // Only a ranked repository is written into the URL. The recent feed reports
  // ready a render before its rows reach the store, so the alphabetical
  // fallback would otherwise be pinned in the URL ahead of the real ranking.
  const rankedRepo = repos[0]?.repo;
  const defaultRepo = rankedRepo ?? (feed.recentReady ? knownRepo : undefined);
  const repo = urlRepo && !foreign ? urlRepo : defaultRepo;
  useWatchEffect(() => {
    if ((!urlRepo || foreign) && rankedRepo) setUrl({ repo: rankedRepo }, "replace");
  }, [urlRepo, foreign, rankedRepo]);

  // ── Store rows ──────────────────────────────────────────────────────────
  const span = useMemo(() => ({ from_date: timelineChunk(today, chunks - 1).from_date, to_date: today }), [today, chunks]);
  const stories = useChangeStories(teamId, repo, span);
  const editions = useChangeEditions(teamId, repo, span);
  const weekWindow = useMemo(() => ({ from_date: "", to_date: "￿" }), []);
  const weeks = useChangeEditions(teamId, repo, weekWindow, "week");
  const live = useChangeLive(teamId, repo);
  const allWorks = useChangeWorks(teamId);
  const works = useMemo(() => allWorks.filter((w) => !repo || (!!w.repository && normalizeRepository(w.repository) === repo)), [allWorks, repo]);

  const roster = useTeamRosterIdentity();
  const fallbackName = useCallback((id: string) => {
    const m = roster.find((r) => r._id === id);
    return m ? memberDisplayName(m) : isConvexId(id) ? "A teammate" : id;
  }, [roster]);
  const people = useMemo(() => peopleOf(stories, roster), [stories, roster]);
  const person = url.person ? personFor(url.person, people) : null;
  const personName = useMemo(() => nameOfPerson(people, fallbackName), [people, fallbackName]);

  const viewUrl = useMemo(() => ({ ...url, story: undefined }), [changesHref({ ...url, story: undefined })]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(
    () => buildTimeline({ stories, editions, weeks, url: viewUrl, person, today }),
    [stories, editions, weeks, viewUrl, person, today],
  );
  const groups = useMemo(() => groupWeeks(items), [items]);
  const shown = useMemo(() => items.flatMap((i) => (i.kind === "day" ? [...i.stories, ...i.small] : [])), [items]);
  const byKey = useMemo(() => new Map(shown.map((s) => [s.story_key, s])), [shown]);

  const areaColors = useMemo(() => {
    const filed = [...new Set(stories.map((s) => s.area))].sort();
    const touched = [...new Set(stories.flatMap((s) => Object.keys(s.area_counts)))].sort();
    return assignAreaColors(filed, touched);
  }, [stories]);
  const options = useMemo<FilterOptions>(() => {
    const count = new Map<string, number>();
    for (const s of stories) count.set(s.area, (count.get(s.area) ?? 0) + 1);
    return {
      areas: [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a).slice(0, 12),
      people: people.map((p) => ({ id: p.key, name: p.name })).slice(0, 12),
    };
  }, [stories, people]);

  // ── Focus and keys ──────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const [focus] = useState(() => createFocusStore(url.story ?? null));
  // The open card mirrors the URL's story, outside React state, so opening one re-renders two cards, not the page.
  const [opened] = useState(() => createFocusStore(url.story ?? null));
  useWatchEffect(() => opened.set(url.story ?? null), [url.story, opened]);
  // The landing below scrolls to a story a link named; one opened here is already on screen.
  const landed = useRef<string | null>(null);
  const toggle = useCallback((key: string) => {
    landed.current = key;
    setUrl((s) => ({ ...s, story: s.story === key ? undefined : key }));
  }, [setUrl]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [worksOpen, setWorksOpen] = useState(false);
  const modern = useIsModernStyle();
  // A story link opens the story whatever the viewer's filters: the repository, the story, and every branch when it is off main.
  const storyLink = useCallback((story: Pick<Story, "story_key" | "on_default_branch">) =>
    `${location.origin}${changesHref({ ...EMPTY_URL, repo, story: story.story_key, branches: story.on_default_branch ? "main" : "all" })}`, [repo]);
  const copyStoryLink = useCallback((story: Story) => void copyText(storyLink(story), "Link to the story copied"), [storyLink]);
  const ctx = useMemo<StoryContext>(() => ({
    focus, opened, pick: focus.set, toggle, areaColors, proseLive: true, live, copyLink: copyStoryLink,
  }), [focus, opened, toggle, areaColors, live, copyStoryLink]);

  const triggers = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-story-trigger]") ?? [])];
  const pointed = (): string | null =>
    (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-story-key]")?.dataset.storyKey ?? focus.get();
  const move = (delta: number) => {
    const all = triggers();
    if (!all.length) return false;
    const at = all.findIndex((t) => t.closest<HTMLElement>("[data-story-key]")?.dataset.storyKey === pointed());
    const next = all[Math.min(all.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
    // An open card can be taller than the screen: j and k bring its headline to the top then.
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: next.offsetHeight > window.innerHeight * 0.6 ? "start" : "nearest" });
    return true;
  };
  const openTarget = (key: string | null) => {
    const story = key ? byKey.get(key) : undefined;
    const href = story && storyTargetHref(story);
    if (!href) return false;
    router.push(href);
    return true;
  };

  useChangesKeys(useTabActive(), {
    today: () => {
      rootRef.current?.closest<HTMLElement>("[data-scroll-root]")?.scrollTo({ top: 0 });
      rootRef.current?.scrollIntoView({ block: "start" });
      return true;
    },
    next: () => move(1),
    prev: () => move(-1),
    evidence: () => {
      // Enter on a link or button inside a change is that control's own.
      if (keepsOwnEnter(document.activeElement)) return false;
      const key = pointed();
      if (!key) return false;
      toggle(key);
      return true;
    },
    open: () => openTarget(pointed()),
    risks: () => setUrl((s) => ({ ...s, risk: !s.risk })),
    filter: () => {
      setFilterOpen(true);
      requestAnimationFrame(() => filterRef.current?.focus());
      return true;
    },
    copyLink: () => {
      const story = byKey.get(pointed() ?? "");
      if (story) copyStoryLink(story);
      else void copyText(`${location.origin}${changesHref(viewUrl)}`, "Link copied");
      return true;
    },
    escape: () => {
      const inField = document.activeElement === filterRef.current;
      const step = escapeStep({ inFilterField: inField, q: url.q, story: url.story, filtered: hasFilters(url), filterOpen });
      if (step === "clear-text") setUrl({ q: undefined });
      else if (step === "leave-field") filterToggleRef.current?.focus();
      else if (step === "close-story") setUrl({ story: undefined });
      else if (step === "clear-filters") setUrl((s) => clearFilters(s));
      else if (step === "close-filter") setFilterOpen(false);
      return step !== null;
    },
  });

  // A linked story lands on screen once its day has painted.
  useWatchEffect(() => {
    const key = url.story;
    if (!key || landed.current === key || !byKey.has(key)) return;
    landed.current = key;
    focus.set(key);
    rootRef.current?.querySelector<HTMLElement>(`[data-story-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center" });
  }, [url.story, byKey, focus]);

  // A linked story older than the loaded weeks: ask which day it sits on, then
  // load back to that week so the landing above finds it. The link names its repository.
  const linked = url.story && !byKey.has(url.story) && feed.ready ? url.story : undefined;
  const cachedDate = useInboxStore((s) => (linked ? (Object.values(s.changeStories ?? {}).find((r: any) => r.story_key === linked) as Story | undefined)?.date : undefined));
  const located = useQueryNoThrow(api.changesQueries.storyLocation, linked && !cachedDate && teamId ? { team_id: teamId as Id<"teams">, story_key: linked } : "skip");
  const linkedDate = cachedDate ?? located?.data?.date;
  useWatchEffect(() => {
    if (!linkedDate) return;
    const back = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${linkedDate}T12:00:00Z`)) / (7 * 86_400_000));
    setChunks((c) => Math.max(c, Math.min(MAX_CHUNKS, back + 1)));
  }, [linkedDate, today]);

  const more = useReach(() => setChunks((c) => (c < MAX_CHUNKS ? c + 1 : c)));
  const cold = !feed.ready && stories.length === 0 && editions.length === 0;
  const filtering = hasFilters(url);

  const header = (
    <TimelineHeader
      repos={repos}
      repo={repo}
      url={url}
      setUrl={setUrl}
      live={live}
      works={works}
      filterOpen={filterOpen}
      onToggleFilter={() => setFilterOpen((o) => !o)}
      filterRef={filterRef}
      filterToggleRef={filterToggleRef}
      options={options}
      personName={personName}
      worksOpen={worksOpen}
      onToggleWorks={() => setWorksOpen((o) => !o)}
    />
  );
  const body = (
        <StoryCtx.Provider value={ctx}>
          {cold ? (
            <Skeleton />
          ) : items.length === 0 ? (
            filtering ? (
              <div className="mt-10"><NoMatch what="changes" onClear={() => setUrl((s) => clearFilters(s))} /></div>
            ) : (
              <p className="chg-ui mt-10 text-[14px] text-sol-text-muted">Nothing has landed in the last {plural(chunks * 7, "day")}.</p>
            )
          ) : (
            <div className="mt-2">
              {groups.map((g) => {
                const label = g.week === isoWeekOf(today) ? "This week" : g.week === isoWeekOf(shiftDay(today, -7)) ? "Last week" : weekLabel(g.week);
                return (
                  <Fragment key={`w-${g.week}`}>
                    {g.notes && <WeekSummary week={g.notes} label={label} />}
                    {g.days.map((d) => <DaySection key={d.date} day={d} today={today} />)}
                  </Fragment>
                );
              })}
            </div>
          )}
          {!cold && (
            <div ref={more} className="mt-6 flex justify-center">
              {chunks < MAX_CHUNKS && (
                <button
                  type="button"
                  onClick={() => setChunks((c) => Math.min(MAX_CHUNKS, c + 1))}
                  className={`rounded px-3 py-1 font-mono text-meta text-sol-text-dim hover:bg-sol-bg-alt/60 hover:text-sol-text/80 ${modernButton({ variant: "ghost", size: "sm" }, "modern:font-sans")}`}
                >
                  earlier
                </button>
              )}
            </div>
          )}
          {Array.from({ length: Math.max(0, chunks - 1) }, (_, i) => (
            <ChangesChunkFeed key={i + 1} teamId={teamId} repository={repo} today={today} k={i + 1} />
          ))}
          {feed.error && cold && <p className="mt-6 font-mono text-meta text-sol-text-muted">Changes could not load: {feed.error.message}</p>}
        </StoryCtx.Provider>
  );

  // Classic and Minimal: the masthead at the top of the page's one column.
  // Modern: the page header pinned above it, the work in progress opening at
  // the top of the column.
  if (modern) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full min-h-0 flex-col">
          {header}
          <div className="min-h-0 flex-1 overflow-y-auto" data-main-scroll>
            <div ref={rootRef} className="chg-root mx-auto w-full max-w-[52rem] px-4 pb-24 sm:px-6">
              {worksOpen && <TimelineWorks works={works} />}
              {body}
            </div>
          </div>
        </div>
      </TooltipProvider>
    );
  }
  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full overflow-y-auto" data-main-scroll>
      <div ref={rootRef} className="chg-root mx-auto w-full max-w-[52rem] px-6 pb-24">
        {header}
        {body}
      </div>
      </div>
    </TooltipProvider>
  );
}
