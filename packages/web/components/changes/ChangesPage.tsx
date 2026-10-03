"use client";
// /changes: a daily edition of what the team shipped and why
// (docs/proposals/changes-page.md 4 to 6 and 9). The route (app/changes/page)
// holds the team and feature gates; this page reads the store only. Feeders
// in hooks/useSyncChanges bring the viewed day and the days around it, so `[`
// and `]` paint from cache, and every piece of the view is in the URL.
//
// Layout: header, live strip, the edition headline, then a 12 column grid of
// the lead story, sections by area, In brief under them, and In the works beside
// (one column below 1100px of page width, in that reading order). Stories are
// one Radix accordion, so one evidence drawer is open at a time; the URL's
// `story=` names it, and the story keeps its place on screen as it opens.
import * as Accordion from "@radix-ui/react-accordion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SURFACE_PATHS, surfaceCoversArea, waitingStories } from "@codecast/shared/changes";
import { normalizeRepository } from "@codecast/shared/contracts";
import { addDays, localDate, normalizeTimezone } from "@codecast/convex/convex/lib/teamDay";
import {
  changesWindow,
  recentWindow,
  useChangeEditions,
  useChangeLive,
  useChangeStories,
  useChangeWorks,
  useSyncChanges,
  weekWindow,
} from "../../hooks/useSyncChanges";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useRepositories } from "../../hooks/useRepoBrowse";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useTabActive } from "../../hooks/usePagePresence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { isEditableTarget } from "../../shortcuts";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { copyText } from "../../lib/copyText";
import { memberDisplayName } from "../../lib/liveEntities";
import { isConvexId, useInboxStore } from "../../store/inboxStore";
import { EmptyState } from "../EmptyState";
import { TeamFeatureOff } from "../TeamFeatureOff";
import { TooltipProvider } from "../ui/tooltip";
import { ChangesFooter } from "./ChangesFooter";
import { ChangesHeader, type FilterOptions, type Summarizing } from "./ChangesHeader";
import { commitPath } from "./EvidenceDrawer";
import { EditionHead } from "./EditionHead";
import { assignAreaColors } from "./areaColor";
import { awaitsStories, buildEdition, dayVolumes, filterAreas, stepOrder } from "./editionModel";
import { InBrief } from "./InBrief";
import { InTheWorks } from "./InTheWorks";
import { LeadStory } from "./LeadStory";
import { LiveStrip, type LiveTile } from "./LiveStrip";
import { SectionBlock } from "./SectionBlock";
import { StoryCtx, type StoryContext } from "./storyContext";
import { escapeStep, keepsOwnEnter, useChangesKeys } from "./useChangesKeys";
import { buildWeek } from "./weekModel";
import { WeekView } from "./WeekView";
import { changesHref, clearFilters, hasFilters, isoWeekOf, stepView, useChangesUrlState, weekDaysOf, weekMonday } from "./useChangesUrlState";

/** `--i` for the first paint's stagger (spec 5.4), capped at 10. */
const rise = (i: number) => ({ ["--i" as any]: Math.min(i, 10) });

const storySelector = (key: string) => `[data-story-key="${CSS.escape(key)}"]`;

function Skeleton() {
  const bar = (w: string, h: number, mt = 0) => (
    <div className="rounded bg-sol-bg-alt/70" style={{ width: w, height: h, marginTop: mt }} />
  );
  return (
    <div className="mt-7 animate-pulse motion-reduce:animate-none" aria-label="Loading the edition">
      {bar("70%", 30)}
      {bar("55%", 15, 14)}
      {bar("48%", 15, 8)}
      <div className="mt-7 rounded-lg border border-sol-border/20 p-5">
        {bar("12%", 10)}
        {bar("60%", 22, 12)}
        {bar("85%", 14, 12)}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="mt-4">{bar(`${50 - i * 6}%`, 14)}{bar(`${70 - i * 5}%`, 12, 6)}</div>
      ))}
    </div>
  );
}

export function ChangesPage() {
  const router = useRouter();
  const { url, setUrl } = useChangesUrlState();
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id as string | undefined);
  const timezone = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId))?.timezone as string | undefined);
  const now = useCoarseNow(60_000);
  const today = timezone ? localDate(now, normalizeTimezone(timezone)) : localDay(0, now);

  // ── The view: a day, or a week ──────────────────────────────────────────
  const mode: "day" | "week" = url.w ? "week" : "day";
  const viewDate = url.d && url.d <= today ? url.d : today;
  const weekDays = useMemo(() => {
    const monday = url.w ? weekMonday(url.w) : null;
    return monday ? Array.from({ length: 7 }, (_, i) => addDays(monday, i)) : weekDaysOf(viewDate);
  }, [url.w, viewDate]);
  // A week is fed around its Thursday, so the fed window is exactly Monday to Sunday.
  const feedDate = mode === "week" ? weekDays[3] : viewDate;
  const fed = useMemo(() => changesWindow(feedDate), [feedDate]);

  // ── Store rows ──────────────────────────────────────────────────────────
  // The repository list is every repository's commits over the last 14 days
  // (spec 4.1), whichever day is on screen, plus any the fed window names.
  // The team's known repositories stand in for a team quiet that long.
  const allStories = useChangeStories(teamId, undefined, fed);
  const recent = useMemo(() => recentWindow(today), [today]);
  const recentEditions = useChangeEditions(teamId, undefined, recent);
  const teamRepos = useRepositories();
  const knownRepos = useMemo(
    () => teamRepos.rows.filter((r) => String(r.team_id) === teamId).map((r) => normalizeRepository(r.repository)).sort(),
    [teamRepos.rows, teamId],
  );
  const repos = useMemo(() => {
    const commits = new Map<string, number>();
    for (const e of recentEditions) if (e.repository) commits.set(e.repository, (commits.get(e.repository) ?? 0) + (e.stats?.commits ?? 0));
    const shas = new Map<string, Set<string>>();
    for (const s of allStories) {
      if (commits.has(s.repository)) continue;
      const set = shas.get(s.repository) ?? new Set<string>();
      for (const sha of s.commit_shas) set.add(sha);
      shas.set(s.repository, set);
    }
    for (const [repo, set] of shas) commits.set(repo, set.size);
    return [...commits.entries()].filter(([, n]) => n > 0).map(([repo, n]) => ({ repo, commits: n })).sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo));
  }, [recentEditions, allStories]);
  const repo = url.repo ? normalizeRepository(url.repo) : repos[0]?.repo ?? knownRepos[0];
  const weekKey = isoWeekOf(weekDays[0]);
  const feed = useSyncChanges({ teamId, repository: repo, date: feedDate, today, week: mode === "week" ? weekKey : undefined });
  const stories = useMemo(() => (repo ? allStories.filter((s) => s.repository === repo) : allStories), [allStories, repo]);
  const editions = useChangeEditions(teamId, repo, fed);
  const live = useChangeLive(teamId, repo);
  const allWorks = useChangeWorks(teamId);
  const works = useMemo(
    () => allWorks.filter((w) => !repo || (w.kind !== "review" && w.kind !== "branch") || normalizeRepository(w.repository) === repo),
    [allWorks, repo],
  );
  const edition = editions.find((e) => e.date === viewDate);
  const weekWin = useMemo(() => weekWindow(weekKey), [weekKey]);
  const weekRow = useChangeEditions(teamId, repo, mode === "week" ? weekWin : undefined, "week")[0];

  const roster = useTeamRosterIdentity();
  const memberName = useCallback(
    (id: string) => {
      const m = roster.find((r) => r._id === id);
      return m ? memberDisplayName(m) : null;
    },
    [roster],
  );
  // `person=` is a user id or a commit author's name; an id never shows as a name.
  const personName = useCallback((id: string) => memberName(id) ?? (isConvexId(id) ? "A teammate" : id), [memberName]);

  const week = useMemo(
    () => (mode === "week" ? buildWeek({ days: weekDays.filter((d) => d <= today), stories, editions, week: weekRow, url, live, personName }) : null),
    [mode, weekDays, today, stories, editions, weekRow, url, live, personName],
  );
  const model = useMemo(
    () => buildEdition({ stories, date: viewDate, edition, live, url, personName }),
    [stories, viewDate, edition, live, url, personName],
  );
  const byKey = useMemo(() => new Map(model.day.map((s) => [s.story_key, s])), [model.day]);
  // One color per area, from the repository's areas across the fed window and
  // not the day's own, so an area wears the same color on every day around
  // it. The areas stories are filed under choose first; areas that only hold
  // files inside other stories take what is left.
  const areaSig = useMemo(() => {
    const filed = new Set<string>();
    const touched = new Set<string>();
    for (const s of stories) {
      filed.add(s.area);
      for (const a of Object.keys(s.area_counts)) touched.add(a);
    }
    return `${[...filed].sort().join("\u0000")}\u0001${[...touched].sort().join("\u0000")}`;
  }, [stories]);
  const areaColors = useMemo(() => {
    const [filed, touched] = areaSig.split("\u0001").map((part) => part.split("\u0000").filter(Boolean));
    return assignAreaColors(filed, touched);
  }, [areaSig]);
  const volumes = useMemo(() => dayVolumes(stories, editions, weekDays), [stories, editions, weekDays]);

  const tiles = useMemo<LiveTile[]>(() => {
    if (!live.length) return [];
    const main = stories.filter((s) => s.on_default_branch);
    const ships: LiveTile[] = live.map((row) => {
      const risky = waitingStories(main, row).filter((s) => s.risks.length);
      const risk = risky.length
        ? risky.slice(0, 4).map((s) => `${s.headline}: ${s.risks.map((r) => `${r.code}${r.evidence.length ? ` (${r.evidence.slice(0, 3).join(", ")})` : ""}`).join(", ")}`).join("\n")
        : null;
      return { kind: "ship", row, risk };
    });
    const known = new Set(live.map((l) => l.surface));
    const areas = new Set(stories.map((s) => s.area));
    const silent: LiveTile[] = Object.keys(SURFACE_PATHS)
      .filter((surface) => !known.has(surface) && [...areas].some((a) => surfaceCoversArea(surface, a)))
      .map((surface) => ({ kind: "silent", surface }));
    return [...ships, ...silent];
  }, [live, stories]);

  // The filter offers what is on screen: the day's stories, or the week's.
  const shown = week?.stories ?? model.day;
  const shownAreas = week?.areas ?? model.areas;
  const order = week?.order ?? model.order;
  const options = useMemo<FilterOptions>(() => {
    const people = new Map<string, string>();
    for (const s of shown) {
      for (const id of s.actor_user_ids) {
        const name = memberName(String(id));
        if (name) people.set(String(id), name);
      }
      for (const a of s.author_names) if (![...people.values()].includes(a)) people.set(a, a);
    }
    return {
      areas: filterAreas(shown, shownAreas),
      people: [...people.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12),
    };
  }, [shown, shownAreas, memberName]);

  const summarizing: Summarizing = useMemo(() => {
    if (mode !== "day") return null;
    if (edition?.dirty_since != null) return { since: edition.dirty_since, stale: edition.stale };
    const recent = viewDate >= addDays(today, -1);
    const pending = model.day.some((s) => s.on_default_branch && s.prose_status === "pending");
    return recent && pending && !edition?.capped_at && edition?.status !== "failed" ? { since: null, stale: false } : null;
  }, [mode, edition, viewDate, today, model.day]);

  // ── Focus, drawer and scroll ────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState<string | null>(url.story ?? null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [focusFilter, setFocusFilter] = useState(0);
  const [introDate] = useState(viewDate);

  // Which way the view slides, read off the view change itself, so every way
  // of moving (keys, Back and Forward, the strip, a pasted link) agrees: a
  // later day or week slides in from the right, an earlier one from the left,
  // and a change of mode or repository does not slide. It holds until the
  // next change, so a render in between keeps the slide it started.
  const viewKey = mode === "week" ? weekKey : viewDate;
  const lastView = useRef({ mode, key: viewKey, repo });
  const travelRef = useRef<"next" | "prev" | null>(null);
  const was = lastView.current;
  if (was.mode !== mode || was.key !== viewKey || was.repo !== repo) {
    travelRef.current = was.mode === mode && was.repo === repo ? (viewKey > was.key ? "next" : "prev") : null;
    lastView.current = { mode, key: viewKey, repo };
  }
  const travel = travelRef.current;

  const storyEl = (key: string) => scrollRef.current?.querySelector<HTMLElement>(storySelector(key)) ?? null;

  // The keyboard goes to a story's own control without moving the page, so
  // Tab and j carry on from the story the reader opened or landed on.
  const focusControl = useCallback((key: string) => {
    const el = storyEl(key);
    const control = el?.matches("button") ? el : el?.querySelector<HTMLElement>("[data-story-trigger]");
    control?.focus({ preventScroll: true });
    return el;
  }, []);

  // Opening a drawer keeps the story it belongs to where it is on screen: a
  // drawer above it closes at once, and the scroll takes up the difference.
  const pin = useRef<{ key: string; top: number } | null>(null);
  const landed = useRef<string | null>(null);
  const openStory = useCallback((key: string | undefined) => {
    const anchor = key ?? url.story;
    const el = anchor ? storyEl(anchor) : null;
    pin.current = anchor && el ? { key: anchor, top: el.getBoundingClientRect().top } : null;
    if (key) {
      setFocused(key);
      focusControl(key);
      // Already on screen: the pin holds it, and the pasted-link landing below must not recenter it.
      landed.current = key;
    }
    setUrl({ story: key });
  }, [url.story, setUrl, focusControl]);
  useLayoutEffect(() => {
    const p = pin.current;
    pin.current = null;
    const el = p ? storyEl(p.key) : null;
    if (!p || !el || !scrollRef.current) return;
    const delta = el.getBoundingClientRect().top - p.top;
    if (Math.abs(delta) >= 1) scrollRef.current.scrollTop += delta;
  }, [url.story]);

  // A pasted `story=` link lands on its story once the story is on the page:
  // centred when it fits the pane, else from its top, so its headline is never
  // cut off by its own drawer.
  useWatchEffect(() => {
    const key = url.story;
    if (!key || landed.current === key || !byKey.has(key)) return;
    landed.current = key;
    setFocused(key);
    const el = focusControl(key);
    const room = (scrollRef.current?.clientHeight ?? 0) - 120;
    el?.scrollIntoView({ block: el.offsetHeight > room ? "start" : "center" });
  }, [url.story, byKey]);

  // A new day, week or repository starts at its top. Not on the first mount
  // (Back and Forward restore their own scroll), and not when a story is
  // being landed on.
  const viewed = useRef(false);
  useLayoutEffect(() => {
    if (!viewed.current) {
      viewed.current = true;
      return;
    }
    if (!url.story && scrollRef.current) scrollRef.current.scrollTop = 0;
    // `url.story` is read, not watched: opening a drawer must not scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, viewKey, repo]);

  useWatchEffect(() => {
    if (focusFilter) filterRef.current?.focus();
  }, [focusFilter]);

  // j and k move the same cursor Tab does: the story's own control takes
  // focus, then the story scrolls into view with room below it (scroll-margin).
  const focusStory = useCallback((key: string | null) => {
    if (!key) return false;
    setFocused(key);
    focusControl(key)?.scrollIntoView({ block: "nearest" });
    return true;
  }, [focusControl]);

  // ── Navigation ──────────────────────────────────────────────────────────
  const goDay = useCallback((day: string) => {
    const target = day > today ? today : day;
    if (mode === "day" && target === viewDate) return false;
    setFocused(null);
    setUrl({ d: target === today ? undefined : target, w: undefined, story: undefined }, "push");
    return true;
  }, [today, viewDate, mode, setUrl]);

  // Today in the mode on screen: this week in week mode, else today.
  const goToday = useCallback(() => {
    if (mode === "day") return goDay(today);
    const week = isoWeekOf(today);
    if (url.w === week) return false;
    setUrl({ w: week, d: undefined, story: undefined }, "push");
    return true;
  }, [mode, today, url.w, goDay, setUrl]);

  // A story picked in the week opens in its day, with its evidence drawer open.
  const goStory = useCallback((day: string, key: string) => {
    setFocused(key);
    setUrl({ d: day >= today ? undefined : day, w: undefined, story: key }, "push");
  }, [today, setUrl]);

  // Relative to the live view, not the one on screen when the key was bound:
  // two quick presses of `[` move two days.
  const step = useCallback((delta: number) => {
    const moved = setUrl((s) => stepView(s, delta, today), "push");
    if (moved) setFocused(null);
    return moved;
  }, [today, setUrl]);

  // Week mode keeps `d`, so a return to day mode lands on the day it left
  // when that day is in the week on screen, else on the week's last day so far.
  const setMode = useCallback((next: "day" | "week") => {
    if (next === mode) return;
    if (next === "week") {
      setUrl({ w: isoWeekOf(viewDate), story: undefined }, "push");
      return;
    }
    const day = url.d && weekDays.includes(url.d) ? url.d : weekDays[6] < today ? weekDays[6] : today;
    setUrl({ w: undefined, d: day === today ? undefined : day }, "push");
  }, [mode, viewDate, url.d, weekDays, today, setUrl]);

  const pickSurface = useCallback((surface: string) => void setUrl((s) => ({ ...s, surface: s.surface === surface ? undefined : surface })), [setUrl]);

  const openTarget = useCallback((key: string | null) => {
    const story = key ? byKey.get(key) : model.lead;
    if (!story) return false;
    const session = story.conversation_ids[0];
    if (session) {
      router.push(`/conversation/${session}`);
      return true;
    }
    const commits = useInboxStore.getState().commits ?? {};
    const sizes = new Map<string, number>();
    for (const c of Object.values(commits) as any[]) {
      if (c && story.commit_shas.includes(c.sha)) sizes.set(c.sha, (c.insertions ?? 0) + (c.deletions ?? 0));
    }
    const sha = [...story.commit_shas].sort((a, b) => (sizes.get(b) ?? -1) - (sizes.get(a) ?? -1))[0];
    if (!sha) return false;
    router.push(commitPath(story.repository, sha));
    return true;
  }, [byKey, model.lead, router]);

  /** The story the reader is on: the one holding keyboard focus in the DOM, else the page's cursor when it is on the page. */
  const pointedStory = useCallback((): string | null => {
    const active = document.activeElement as HTMLElement | null;
    const inStory = active?.closest<HTMLElement>("[data-story-key]")?.dataset.storyKey;
    if (inStory) return inStory;
    const onPage = !!focused && (mode === "week" ? !!week?.top.some((s) => s.story_key === focused) : byKey.has(focused));
    return onPage ? focused : null;
  }, [focused, mode, week, byKey]);

  /** The story e and o act on: the one the reader is on, else the first. */
  const keyTarget = useCallback((): string | null => pointedStory() ?? order[0] ?? null, [pointedStory, order]);

  // In the week a story opens in its day, where its evidence is.
  const openInDay = useCallback((key: string | null) => {
    const story = key ? week?.top.find((s) => s.story_key === key) : undefined;
    if (!story) return false;
    goStory(story.date, story.story_key);
    return true;
  }, [week, goStory]);

  useChangesKeys(useTabActive(), {
    prevDay: () => step(-1),
    nextDay: () => step(1),
    today: goToday,
    next: () => focusStory(stepOrder(order, focused, 1)),
    prev: () => focusStory(stepOrder(order, focused, -1)),
    evidence: () => {
      // Enter on a link or button keeps its own meaning, inside a story too
      // (a commit link, a session pill, "+149 more files"). `e` is never a
      // control's own key, so it reaches the story from anywhere inside it.
      const active = document.activeElement as HTMLElement | null;
      const byEnter = (window.event as KeyboardEvent | undefined)?.key !== "e";
      if (keepsOwnEnter(active) && (byEnter || !active?.closest("[data-story-key]"))) return false;
      const key = keyTarget();
      if (!key) return false;
      if (mode === "week") return openInDay(key);
      openStory(url.story === key ? undefined : key);
      return true;
    },
    open: () => (mode === "week" ? openInDay(keyTarget()) : openTarget(keyTarget())),
    waiting: () => {
      // Nothing ships here yet, so nothing waits: the key has nothing to show.
      if (!tiles.length && !url.waiting) return false;
      setUrl((s) => ({ ...s, waiting: !s.waiting }));
      stripRef.current?.scrollIntoView({ block: "start" });
      return true;
    },
    risks: () => setUrl((s) => ({ ...s, risk: !s.risk })),
    branches: () => setUrl((s) => ({ ...s, branches: s.branches === "all" ? "main" : "all" })),
    mode: () => (setMode(mode === "day" ? "week" : "day"), true),
    filter: () => {
      setFilterOpen(true);
      setFocusFilter((n) => n + 1);
      return true;
    },
    copyLink: () => {
      // The story the reader is on, else the view itself: never a story they did not pick.
      const key = pointedStory();
      // A week story links to its day, where it opens; the week links to itself.
      const inWeek = mode === "week" && key ? week?.top.find((s) => s.story_key === key) : undefined;
      const href = changesHref(
        inWeek ? { ...url, d: inWeek.date, w: undefined, story: inWeek.story_key }
          : mode === "week" ? { ...url, d: undefined, story: undefined }
          : { ...url, d: viewDate, story: key ?? undefined },
      );
      const what = key ? "Link to the story copied" : mode === "week" ? "Link to the week copied" : "Link to the day copied";
      void copyText(`${window.location.origin}${href}`, what);
      return true;
    },
    escape: () => {
      // A field outside the page (the topbar search) keeps its own Escape.
      const active = document.activeElement as HTMLElement | null;
      if (isEditableTarget(active) && !active?.closest(".chg-root")) return false;
      switch (escapeStep({ inFilterField: active === filterRef.current, q: url.q, story: url.story, filtered: hasFilters(url), filterOpen })) {
        case "clear-text":
          setUrl({ q: undefined });
          return true;
        case "leave-field":
        case "close-filter":
          setFilterOpen(false);
          filterRef.current?.blur();
          return true;
        case "close-story":
          openStory(undefined);
          return true;
        case "clear-filters":
          setUrl(clearFilters);
          return true;
        default:
          return false;
      }
    },
  });

  const storyCtx = useMemo<StoryContext>(
    () => ({ focused, waiting: model.waiting, dimmed: model.dimmed, pick: setFocused, areaColors }),
    [focused, model.waiting, model.dimmed, areaColors],
  );

  // ── States ──────────────────────────────────────────────────────────────
  // A skeleton only while the view has no stories cached and its feed has
  // not answered: a cached day or week paints at once, and "Nothing landed"
  // waits for the server, or the view's own editions, to say so.
  const cold = mode === "week"
    ? awaitsStories(week!.stories.length, feed.windowReady, week!.days.map((d) => editions.find((e) => e.date === d.date)))
    : awaitsStories(model.day.length, feed.ready, [edition]);
  // "Nothing to write about" is for a team with no history at all; any known
  // repository or edition makes an empty day a quiet day.
  const nothingKnown =
    feed.ready && feed.recentReady && (teamRepos.ready || !!teamRepos.error) && !url.repo &&
    !repo && repos.length === 0 && editions.length === 0 && recentEditions.length === 0 && live.length === 0;

  if (feed.refused) {
    return <TeamFeatureOff feature="changes" />;
  }
  if (nothingKnown) {
    return (
      <EmptyState
        title="Nothing to write about yet"
        description="Changes is written from your team's commits. Connect GitHub or run cast in a repo to start the first edition."
        action={{ label: "Connect GitHub", href: "/settings/integrations" }}
      />
    );
  }

  // Counts are a claim; while the view is still loading there is none to make.
  const stats = cold ? null : (week?.stats ?? model.stats);
  const intro = viewDate === introDate && !travel;
  const motion = (i: number) => (intro ? { className: "chg-rise", style: rise(i) } : { className: "", style: undefined });
  const quiet = model.day.length === 0;
  const previous =
    [...editions, ...recentEditions.filter((e) => e.repository === repo)]
      .filter((e) => e.date < viewDate && (e.stats?.commits ?? 1) > 0).map((e) => e.date).sort().pop() ?? addDays(viewDate, -1);
  const strip = tiles.length > 0 && (
    <div className="mt-4">
      <LiveStrip tiles={tiles} stories={stories} activeSurface={url.surface} onPick={pickSurface} stripRef={stripRef} animate={intro} />
    </div>
  );

  // The main column is one grid cell, with In the works pinned beside it and
  // In brief, so the grid never depends on which regions exist. In brief sits
  // directly under the sections, or takes the column itself when it is all
  // the day has.
  const noMatch = !quiet && model.matching === 0 && hasFilters(url);
  const hasStories = !!model.lead || model.sections.length > 0;
  const brief = model.brief.length > 0 && <InBrief stories={model.brief} />;
  const briefRow = !!brief && !noMatch && hasStories;
  const mainColumn = noMatch ? (
    <div className="rounded-lg border border-dashed border-sol-border/40 px-5 py-8 text-center">
      <p className="chg-ui text-[14px] text-sol-text/70">No stories match these filters.</p>
      <button type="button" onClick={() => setUrl(clearFilters)} className="mt-2 font-mono text-[11px] text-sol-text/60 underline-offset-2 hover:text-sol-text hover:underline">
        clear filters
      </button>
    </div>
  ) : hasStories ? (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-7">
      {model.lead && (
        <div className={motion(3).className} style={motion(3).style}>
          <LeadStory story={model.lead} open={url.story === model.lead.story_key} echo={model.leadEchoesHeadline} />
        </div>
      )}
      {model.sections.length > 0 && (
        <div className={`chg-sections ${motion(5).className}`} style={motion(5).style}>
          {model.sections.map((sec) => <SectionBlock key={sec.area} section={sec} stories={stories} />)}
        </div>
      )}
    </div>
  ) : brief ? (
    <div className={motion(6).className} style={motion(6).style}>{brief}</div>
  ) : null;

  return (
    <TooltipProvider delayDuration={250}>
      <StoryCtx.Provider value={storyCtx}>
      <div ref={scrollRef} className="chg-root h-full overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-6">
          <ChangesHeader
            repos={repos}
            repo={repo}
            date={mode === "day" ? viewDate : ""}
            today={today}
            weekDays={weekDays}
            volumes={volumes}
            stats={stats}
            summarizing={summarizing}
            url={url}
            setUrl={setUrl}
            mode={mode}
            onDay={goDay}
            onToday={goToday}
            onStep={step}
            onMode={setMode}
            filterOpen={filterOpen}
            onToggleFilter={() => {
              setFilterOpen((o) => !o);
              setFocusFilter((n) => n + 1);
            }}
            filterRef={filterRef}
            options={options}
            personName={personName}
            hasSignals={live.length > 0}
          />

          {cold ? (
            feed.error
              ? <p className="mt-7 font-mono text-[11px] text-sol-text/55">Changes could not load: {feed.error.message}</p>
              : <Skeleton />
          ) : mode === "week" ? (
              <div key={weekKey} className={travel === "next" ? "chg-slide-next" : travel === "prev" ? "chg-slide-prev" : ""}>
                <WeekView
                  week={week!}
                  works={works}
                  today={today}
                  reserve={!week!.prose && !!weekRow && !weekRow.capped_at && weekRow.status !== "failed"}
                  animate={!travel}
                  onDay={goDay}
                  onStory={goStory}
                  onClearFilters={() => setUrl(clearFilters)}
                />
              </div>
          ) : (
              <div key={viewDate} className={travel === "next" ? "chg-slide-next" : travel === "prev" ? "chg-slide-prev" : ""}>
                {strip}
                <Accordion.Root type="single" collapsible value={url.story ?? ""} onValueChange={(v) => openStory(v || undefined)}>
                  <div className="chg-grid mt-7">
                    <div className={`chg-span-12 ${motion(0).className}`} style={motion(0).style}>
                      {quiet ? (
                        <div>
                          <h2 className="chg-headline text-sol-text/80">
                            Nothing landed {url.branches === "all" ? "" : "on main "}on {changesDayLabel(viewDate)}{viewDate === today ? " yet" : ""}.
                          </h2>
                          <button type="button" onClick={() => goDay(previous)} className="mt-3 font-mono text-[12px] text-sol-text/60 underline-offset-2 hover:text-sol-text hover:underline">
                            Read the edition of {changesDayLabel(previous)}
                          </button>
                        </div>
                      ) : (
                        <EditionHead
                          headline={model.headline}
                          standfirst={model.standfirst}
                          reserve={!model.prose && !edition?.capped_at && edition?.status !== "failed"}
                          filterLine={model.filterLine}
                          onClear={() => setUrl(clearFilters)}
                        />
                      )}
                    </div>

                    {mainColumn && <div className="chg-span-8">{mainColumn}</div>}
                    {briefRow && <div className={`chg-span-8 ${motion(6).className}`} style={motion(6).style}>{brief}</div>}
                    <aside className={`chg-works ${motion(4).className}`} style={motion(4).style} aria-label="In the works">
                      <InTheWorks
                        works={works}
                        areas={model.areas}
                        areasLabel={viewDate === today ? "Areas today" : `Areas on ${changesDayLabel(viewDate)}`}
                        live={viewDate === today}
                        viewed={changesDayLabel(viewDate) ?? viewDate}
                      />
                    </aside>
                  </div>
                </Accordion.Root>
              </div>
          )}

          <ChangesFooter stats={stats} edition={mode === "day" ? edition : weekRow} hasSignals={live.length > 0 || !feed.liveReady} mode={mode} date={mode === "day" ? viewDate : ""} today={today} />
        </div>
      </div>
      </StoryCtx.Provider>
    </TooltipProvider>
  );
}
