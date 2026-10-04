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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { buildTimeline, type TimelineDay } from "./timelineModel";
import { escapeStep, focusedCommitHref, keepsOwnEnter, useChangesKeys } from "./useChangesKeys";
import { changesHref, clearFilters, hasFilters, useChangesUrlState } from "./useChangesUrlState";

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

function DaySection({ day, today }: { day: TimelineDay; today: string }) {
  const label = day.date === today ? "Today" : changesDayLabel(day.date);
  const count = day.stories.length + day.small.length;
  const meta = [
    count < day.total ? `${count} of ${day.total} changes` : plural(count, "change"),
    ...day.releases.map((r) => `${releaseName(r)} shipped`),
  ].join(" · ");
  return (
    <section className="chg-day grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 border-t border-sol-border/15 py-6 first:border-t-0" aria-label={label ?? day.date}>
      <h2 className="sticky top-3 self-start pt-0.5 font-mono text-[12px] tabular-nums text-sol-text/55">{label}</h2>
      <div className="min-w-0">
        {day.summary && <p className="chg-ui text-[16px] font-semibold leading-[1.4] text-sol-text [overflow-wrap:anywhere]">{day.summary}</p>}
        <p className={`font-mono text-[11px] tabular-nums text-sol-text/45 ${day.summary ? "mt-1" : ""}`}>{meta}</p>
        <div className="-mx-3 mt-3">
          {day.stories.map((s) => <StoryRow key={s.story_key} story={s} />)}
          <SmallChanges stories={day.small} />
        </div>
      </div>
    </section>
  );
}

function WeekDivider({ headline }: { headline: string }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 pb-2 pt-8">
      <span className="font-mono text-[11px] text-sol-text/40">week</span>
      <p className="chg-ui text-[13px] leading-[1.5] text-sol-text/60">{headline}</p>
    </div>
  );
}

/** Calls `onReach` whenever the element scrolls into view (or near it). */
function useReach(onReach: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const reach = useRef(onReach);
  reach.current = onReach;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && reach.current(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
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
  const feed = useSyncChangesTimeline({ teamId, repository: url.repo ? normalizeRepository(url.repo) : undefined, today, chunks });
  const defaultRepo = feed.recentReady || recentEditions.length ? repos[0]?.repo ?? knownRepo : undefined;
  const repo = url.repo ? normalizeRepository(url.repo) : defaultRepo;
  useWatchEffect(() => {
    if (!url.repo && defaultRepo) setUrl({ repo: defaultRepo }, "replace");
  }, [url.repo, defaultRepo]);

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
  const items = useMemo(() => buildTimeline({ stories, editions, weeks, url: viewUrl, person, today }), [stories, editions, weeks, viewUrl, person, today]);
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
  useEffect(() => {
    const key = url.story;
    if (!key || landed.current === key || !byKey.has(key)) return;
    landed.current = key;
    focus.set(key);
    rootRef.current?.querySelector<HTMLElement>(`[data-story-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center" });
  }, [url.story, byKey, focus]);

  const more = useReach(() => setChunks((c) => (c < MAX_CHUNKS ? c + 1 : c)));
  const cold = !feed.ready && stories.length === 0 && editions.length === 0;
  const filtering = hasFilters(url);

  return (
    <TooltipProvider delayDuration={300}>
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
              {items.map((item) =>
                item.kind === "week"
                  ? <WeekDivider key={`w-${item.week}`} headline={item.headline} />
                  : <DaySection key={item.date} day={item} today={today} />,
              )}
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
    </TooltipProvider>
  );
}
