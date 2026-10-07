"use client";
// /changes: one timeline of what the team shipped, newest day first
// (docs/proposals/changes-page.md). The route (app/changes/page) holds the
// team and feature gates; this page reads the store only. The newest week is
// fed by useSyncChangesTimeline, and each older week by a ChangesChunkFeed the
// page mounts as the reader scrolls to it.
//
// Each day is one sentence and its stories, one line each; a story opens in
// place to its body, its why and its evidence. Housekeeping folds under one
// line per day, and a week's summary sits where the timeline enters the
// week. Filters, the work in progress and what is live stay in the header.
import * as Accordion from "@radix-ui/react-accordion";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isoWeekOf, weekDates, weekMonday } from "@codecast/shared/changes";
import { normalizeRepository } from "@codecast/shared/contracts";
import { localDate, normalizeTimezone } from "@codecast/convex/convex/lib/teamDay";
import {
  ChangesChunkFeed,
  recentWindow,
  storyCommits,
  timelineChunk,
  useChangeEditions,
  useChangeLive,
  useChangeStories,
  useChangeWorks,
  useSyncChangesTimeline,
  type StoryRow as Story,
} from "../../hooks/useSyncChanges";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useRepositories } from "../../hooks/useRepoBrowse";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useTabActive } from "../../hooks/usePagePresence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { copyText } from "../../lib/copyText";
import { memberDisplayName } from "../../lib/liveEntities";
import { isConvexId, useInboxStore } from "../../store/inboxStore";
import { TooltipProvider } from "../ui/tooltip";
import { TimelineHeader, type FilterOptions } from "./ChangesHeader";
import { commitPath } from "./EvidenceDrawer";
import { assignAreaColors } from "./areaColor";
import { nameOfPerson, peopleOf, personFor } from "./editionModel";
import { plural } from "./format";
import { NoMatch } from "./StoryParts";
import { StoryRow } from "./StoryRow";
import { StoryCtx, createFocusStore, type StoryContext } from "./storyContext";
import { pickMedia, type PickedMedia } from "./storyMedia";
import { SummaryMedia } from "./SummaryMedia";
import { buildTimeline, dayZoom, groupWeeks, weekFolds, weekTop, type TimelineDay, type TimelineWeek } from "./timelineModel";
import { escapeStep, focusedCommitHref, keepsOwnEnter, useChangesKeys } from "./useChangesKeys";
import { changesHref, clearFilters, hasFilters, useChangesUrlState, type Zoom } from "./useChangesUrlState";
import { useMountEffect } from "../../hooks/useMountEffect";

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

/** The day's housekeeping, folded under one line until asked for. */
function SmallChanges({ stories }: { stories: readonly Story[] }) {
  const [open, setOpen] = useState(false);
  if (!stories.length) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded px-3 py-1 font-mono text-[11px] text-sol-text/45 hover:bg-sol-bg-alt/60 hover:text-sol-text/80"
      >
        {open ? "hide" : "+"} {plural(stories.length, "small change")}
      </button>
      {open && stories.map((s) => <StoryRow key={s.story_key} story={s} />)}
    </div>
  );
}

/** The stories a summary leads with: the edition's picks, else the heaviest. */
const leadStories = (day: TimelineDay) => [...day.stories, ...day.small];

/** The day's sentence and its few sentences of story, under the date. */
function DayHead({ day, meta }: { day: TimelineDay; meta: string }) {
  return (
    <>
      {day.summary && <p className="chg-ui text-[17px] font-bold leading-[1.35] tracking-tight text-sol-text [overflow-wrap:anywhere]">{day.summary}</p>}
      {day.standfirst && <p className="chg-ui mt-2 max-w-[44rem] text-[14px] leading-[1.65] text-sol-text/75 [overflow-wrap:anywhere]">{day.standfirst}</p>}
      <p className={`font-mono text-[11px] tabular-nums text-sol-text/45 ${day.summary ? "mt-2" : ""}`}>{meta}</p>
    </>
  );
}

function ZoomIn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 rounded px-2 py-1 -ml-2 font-mono text-[11px] text-sol-text/50 hover:bg-sol-bg-alt/60 hover:text-sol-text"
    >
      {children}
    </button>
  );
}

/**
 * One day. At "changes" every story is a row that opens in place; at "days"
 * the day is told whole: its sentence, its story in a few sentences, its
 * screenshots and pages, and the stories most worth opening.
 */
function DaySection({ day, today, zoom, onOpen, onZoomIn }: {
  day: TimelineDay;
  today: string;
  zoom: Zoom;
  onOpen: (key: string) => void;
  onZoomIn: () => void;
}) {
  const label = day.date === today ? "Today" : changesDayLabel(day.date);
  const count = day.stories.length + day.small.length;
  const meta = [
    count < day.total ? `${count} of ${day.total} changes` : plural(count, "change"),
    ...day.releases.map((r) => `${releaseName(r)} shipped`),
  ].join(" · ");
  // Every zoom shows the day's pictures; story by story, a few, since each story holds its own.
  const media = useMemo(() => pickMedia(leadStories(day), zoom === "changes" ? 3 : 4), [day, zoom]);
  const top = day.stories.slice(0, 3);
  return (
    <section className="chg-day grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 border-t border-sol-border/15 py-6 first:border-t-0" aria-label={label ?? day.date}>
      <h2 className="sticky top-3 self-start pt-1 font-mono text-[12px] tabular-nums text-sol-text/55">{label}</h2>
      <div className="min-w-0">
        <DayHead day={day} meta={meta} />
        {zoom === "changes" ? (
          <>
          <SummaryMedia media={media} onOpen={onOpen} />
          <div className="-mx-3 mt-4">
            {day.stories.map((s) => <StoryRow key={s.story_key} story={s} />)}
            <SmallChanges stories={day.small} />
          </div>
          </>
        ) : (
          <>
            <SummaryMedia media={media} onOpen={onOpen} />
            {top.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {top.map((s) => (
                  <li key={s.story_key}>
                    <button type="button" onClick={() => onOpen(s.story_key)} className="chg-ui text-left text-[13.5px] font-medium leading-[1.45] text-sol-text/80 underline-offset-2 hover:text-sol-text hover:underline">
                      {s.headline}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <ZoomIn onClick={onZoomIn}>every change of the day ({count}) →</ZoomIn>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A week told whole: its headline, a few sentences on what shipped and what
 * it adds up to, and the stories most worth opening. Folded, it stands for its
 * days and carries their screenshots and pages; unfolded, it heads them.
 */
function WeekSummary({ week, label, byKey, onOpen, media, days, onZoomIn }: {
  week: TimelineWeek;
  label: string;
  byKey: ReadonlyMap<string, Story>;
  onOpen: (key: string) => void;
  media?: PickedMedia[];
  days?: number;
  onZoomIn?: () => void;
}) {
  const top = weekTop(week, byKey);
  return (
    <section className="chg-week grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 border-t border-sol-border/15 py-6 first:border-t-0" aria-label={label}>
      <h2 className="sticky top-3 self-start pt-1 font-mono text-[12px] text-sol-text/55">{label}</h2>
      <div className={`min-w-0 ${media ? "" : "rounded-lg bg-sol-bg-alt/50 px-5 py-4"}`}>
        <p className={`chg-ui font-bold leading-[1.3] tracking-tight text-sol-text [overflow-wrap:anywhere] ${media ? "text-[20px]" : "text-[16px]"}`}>{week.headline}</p>
        {week.summary && <p className="chg-ui mt-2 max-w-[44rem] text-[14px] leading-[1.65] text-sol-text/75 [overflow-wrap:anywhere]">{week.summary}</p>}
        {media && <SummaryMedia media={media} onOpen={onOpen} />}
        {top.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {top.map((s) => (
              <li key={s.story_key}>
                <button type="button" onClick={() => onOpen(s.story_key)} className="chg-ui text-left text-[13.5px] font-medium leading-[1.45] text-sol-text/75 underline-offset-2 hover:text-sol-text hover:underline">
                  {s.headline}
                </button>
              </li>
            ))}
          </ul>
        )}
        {onZoomIn && days ? <ZoomIn onClick={onZoomIn}>the week day by day ({plural(days, "day")}) →</ZoomIn> : null}
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
  const defaultRepo = feed.recentReady || recentEditions.length ? repos[0]?.repo ?? knownRepo : undefined;
  const repo = urlRepo && !foreign ? urlRepo : defaultRepo;
  useWatchEffect(() => {
    if ((!urlRepo || foreign) && defaultRepo) setUrl({ repo: defaultRepo }, "replace");
  }, [urlRepo, foreign, defaultRepo]);

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
  const [filterOpen, setFilterOpen] = useState(false);
  const ctx = useMemo<StoryContext>(() => ({
    focus, waiting: new Set(), dimmed: new Set(), pick: focus.set, areaColors, proseLive: true,
  }), [focus, areaColors]);

  const triggers = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-story-trigger]") ?? [])];
  const pointed = (): string | null =>
    (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-story-key]")?.dataset.storyKey ?? focus.get();
  const move = (delta: number) => {
    const all = triggers();
    if (!all.length) return false;
    const at = all.findIndex((t) => t.closest<HTMLElement>("[data-story-key]")?.dataset.storyKey === pointed());
    const next = all[Math.min(all.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    return true;
  };
  const openTarget = (key: string | null) => {
    const story = key ? byKey.get(key) : undefined;
    if (!story) return false;
    const session = story.conversation_ids[0];
    if (session) {
      router.push(`/conversation/${session}`);
      return true;
    }
    const sizes = new Map<string, number>();
    for (const c of storyCommits(story, Object.values(useInboxStore.getState().commits ?? {}))) sizes.set(c.sha, (c.insertions ?? 0) + (c.deletions ?? 0));
    const sha = [...story.commit_shas].sort((a, b) => (sizes.get(b) ?? -1) - (sizes.get(a) ?? -1))[0];
    if (!sha) return false;
    router.push(commitPath(story.repository, sha));
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
      const active = document.activeElement as HTMLElement | null;
      const byEnter = (window.event as KeyboardEvent | undefined)?.key !== "e";
      if (keepsOwnEnter(active) && (byEnter || !active?.closest("[data-story-key]"))) return false;
      const key = pointed();
      if (!key) return false;
      setUrl({ story: url.story === key ? undefined : key });
      return true;
    },
    open: () => {
      const commit = focusedCommitHref(document.activeElement);
      if (commit) {
        router.push(commit);
        return true;
      }
      return openTarget(pointed());
    },
    risks: () => setUrl((s) => ({ ...s, risk: !s.risk })),
    filter: () => {
      setFilterOpen(true);
      requestAnimationFrame(() => filterRef.current?.focus());
      return true;
    },
    copyLink: () => {
      const key = pointed();
      const href = `${location.origin}${changesHref({ ...url, story: key ?? undefined })}`;
      void copyText(href, key ? "Link to the story copied" : "Link copied");
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
  const landed = useRef<string | null>(null);
  useWatchEffect(() => {
    const key = url.story;
    if (!key || landed.current === key || !byKey.has(key)) return;
    landed.current = key;
    focus.set(key);
    rootRef.current?.querySelector<HTMLElement>(`[data-story-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center" });
  }, [url.story, byKey, focus]);

  /** Open a story from outside its day (a week's top list): the landing effect scrolls it on screen. */
  const openStory = useCallback((key: string) => {
    landed.current = null;
    setUrl({ story: key });
  }, [setUrl]);

  // Days and weeks the reader opened one level closer than the zoom puts them.
  const [zoomedIn, setZoomedIn] = useState<ReadonlySet<string>>(() => new Set());
  useWatchEffect(() => setZoomedIn(new Set()), [url.zoom]);
  const zoomIn = useCallback((period: string) => setZoomedIn((z) => new Set(z).add(period)), []);

  const more = useReach(() => setChunks((c) => (c < MAX_CHUNKS ? c + 1 : c)));
  const cold = !feed.ready && stories.length === 0 && editions.length === 0;
  const filtering = hasFilters(url);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full overflow-y-auto" data-main-scroll>
      <div ref={rootRef} className="chg-root mx-auto w-full max-w-[52rem] px-6 pb-24">
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
        />
        <StoryCtx.Provider value={ctx}>
          {cold ? (
            <Skeleton />
          ) : items.length === 0 ? (
            filtering ? (
              <div className="mt-10"><NoMatch what="changes" onClear={() => setUrl((s) => clearFilters(s))} /></div>
            ) : (
              <p className="chg-ui mt-10 text-[14px] text-sol-text/55">Nothing has landed in the last {plural(chunks * 7, "day")}.</p>
            )
          ) : (
            <Accordion.Root type="single" collapsible value={url.story ?? ""} onValueChange={(v) => setUrl({ story: v || undefined })} className="mt-4">
              {groups.map((g) => {
                const label = g.week === isoWeekOf(today) ? "This week" : g.week === isoWeekOf(shiftDay(today, -7)) ? "Last week" : weekLabel(g.week);
                const holdsOpen = (d: TimelineDay) => !!url.story && [...d.stories, ...d.small].some((s) => s.story_key === url.story);
                if (g.notes && !zoomedIn.has(g.week) && !g.days.some(holdsOpen) && weekFolds(g, today, url.zoom)) {
                  const dates = new Set(weekDates(g.week) ?? []);
                  const lead = [...weekTop(g.notes, byKey), ...g.days.flatMap(leadStories)].filter((s, i, all) => dates.has(s.date) && all.indexOf(s) === i);
                  return (
                    <WeekSummary
                      key={`w-${g.week}`}
                      week={g.notes}
                      label={label}
                      byKey={byKey}
                      onOpen={openStory}
                      media={pickMedia(lead, 5)}
                      days={g.days.length}
                      onZoomIn={() => zoomIn(g.week)}
                    />
                  );
                }
                return (
                  <Fragment key={`w-${g.week}`}>
                    {g.notes && <WeekSummary week={g.notes} label={label} byKey={byKey} onOpen={openStory} />}
                    {g.days.map((d) => {
                      const level = zoomedIn.has(d.date) || holdsOpen(d) ? "changes" : dayZoom(d.date, today, url.zoom);
                      return <DaySection key={d.date} day={d} today={today} zoom={level === "weeks" ? "days" : level} onOpen={openStory} onZoomIn={() => zoomIn(d.date)} />;
                    })}
                  </Fragment>
                );
              })}
            </Accordion.Root>
          )}
          {!cold && (
            <div ref={more} className="mt-6 flex justify-center">
              {chunks < MAX_CHUNKS && (
                <button
                  type="button"
                  onClick={() => setChunks((c) => Math.min(MAX_CHUNKS, c + 1))}
                  className="rounded px-3 py-1 font-mono text-[11px] text-sol-text/45 hover:bg-sol-bg-alt/60 hover:text-sol-text/80"
                >
                  earlier
                </button>
              )}
            </div>
          )}
          {Array.from({ length: Math.max(0, chunks - 1) }, (_, i) => (
            <ChangesChunkFeed key={i + 1} teamId={teamId} repository={repo} today={today} k={i + 1} />
          ))}
          {feed.error && cold && <p className="mt-6 font-mono text-[11px] text-sol-text/55">Changes could not load: {feed.error.message}</p>}
        </StoryCtx.Provider>
      </div>
      </div>
    </TooltipProvider>
  );
}
