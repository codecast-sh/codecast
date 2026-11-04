// The Ops home (/ops): is anything wrong right now, across every source. A
// strip of counts, one per kind of wrong (each a filter, the one on shown as
// a token beside the list's count), a band of the watches that are not fine
// and not already rows (the healthy ones behind their count), one ranked list
// that mixes what is wrong, one row per cause (a failing reader is one row
// over every watch it blinds), and every source's health under it with the same 24h count its own
// chart totals. The list triages like an issue stream: j and k move a cursor,
// Enter opens, e resolves, s snoozes, a assigns to me, f starts a fix, x
// selects (shift for a range) and a selection takes the same acts in bulk.
// Rows that went wrong since the last visit are marked. With no source
// connected it is the connect step, done in place, and nothing green
// pretends otherwise.
import { useContext, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, Clock, Plug, Plus, UserPlus, X } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { relTimeShort } from "../../lib/utils";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { opsHref, type OpsHomeShow } from "./opsPaths";
import { ATTENTION_FILTERS, BADGE_STATES, TILE_LANE, admitsShow, filterWords, attentionCounts, attentionItems, healthBad, isNewSince, homeIssueRefs, itemsForSource, resolveSource, sourceLastDay, type AttentionInput, type AttentionItem } from "./opsHomeModel";
import type { SyncCollectionResult } from "../../hooks/useSyncCollection";
import { OpsFeedError, ProviderIcon, SOURCE_PROVIDER_LABEL, SourceHealthContext, useOpsFeed } from "./parts";
import { HealthFixButton } from "./SourceHealthParts";
import { SourceOverview } from "./SourceOverview";
import { eventsLast24h } from "./sourceViewModel";
import { ATTENTION_CLOCK_MS, useAttentionInput, useOpsSnoozes } from "./useOpsAttention";
import { TONE_VAR, type SourceHealth } from "./sourceHealth";
import { attentionIssueCount, issueTotals, openFeederFull, rangeIds } from "./issuesModel";
import { OPS_OPEN_GROUPS_LIMIT } from "../../hooks/useSyncOps";
import { rememberIssueList } from "./issueNav";
import { undoTriage } from "./issueUndo";
import { snoozeChoices, snoozedUntil, splitSnoozed, type OpsSnoozes } from "./opsSnooze";
import { AttentionRow } from "./OpsHomeRow";
import { assignItems, itemHref, itemRef, resolvableGroups, resolveItems, snoozeItems } from "./opsHomeItems";
import { WatchBand } from "./WatchBand";
import { ConnectSheet } from "./ConnectSheet";
import type { Kind } from "./SourcesSection";
import type { OpsGroup, OpsSource } from "./opsTypes";
import "./opsHome.css";
import "./issues.css";

type HealthMap = ReadonlyMap<string, SourceHealth>;
const NO_HEALTH: HealthMap = new Map();

/** What a source's overview already shows in its own panels (open issues, watches), so its list under them holds only the rest. */
/** Inside one source, what its overview's own panels already list: a watch (its Watches panel), and a replay whose issue is open (that issue's row). */
function onOverview(it: AttentionItem): boolean {
  if (it.kind === "watch") return true;
  return it.kind === "replay" && it.group?.status === "open";
}

/** Rows drawn before "Show all": a bad day can list hundreds of new issues. */
const HOME_ROWS = 50;

export function OpsHome({ source, show }: { source: string | null; show: OpsHomeShow | null }) {
  const data = useAttentionInput();
  const sourcesFeed = useOpsFeed("sources");
  // The shell's clock and health reading, so the strip adds up to the Overview tab's count and the sidebar's.
  const now = useCoarseNow(ATTENTION_CLOCK_MS);
  const health = useContext(SourceHealthContext) ?? NO_HEALTH;
  const snoozes = useOpsSnoozes();
  const seenAt = useLastVisit();
  // A source opens on its overview (SourceOverview): its header, then what is wrong with it (this list, as on the home), then volume, issues, replays and watches.
  const named = resolveSource(data.sources, source);
  const view = <OpsHomeView data={data} sourcesFeed={sourcesFeed} now={now} source={source} show={show} health={health} snoozes={snoozes} seenAt={seenAt} />;
  // A source this workspace does not have never reaches here: OpsArea's SourceGate says so on every page.
  return named ? <SourceOverview source={named} needs={view} /> : view;
}

/**
 * When the person last left the home, read once as the page opens (so the
 * marks hold while they read), and stamped as they leave it or hide the tab.
 */
function useLastVisit(): number | null {
  const [prev] = useState(() => (useInboxStore.getState().clientState.ui?.ops_seen_at as number | undefined) ?? null);
  useWatchEffect(() => {
    const stamp = () => useInboxStore.getState().updateClientUI({ ops_seen_at: Date.now() });
    const onHide = () => document.visibilityState === "hidden" && stamp();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      stamp();
    };
  }, []);
  return prev;
}

type ViewProps = { data: AttentionInput; sourcesFeed?: SyncCollectionResult; now: number; source: string | null; show: OpsHomeShow | null; health: HealthMap; snoozes?: OpsSnoozes; seenAt?: number | null };

/** The home drawn from its lists, so it mounts in a test without a store. */
export function OpsHomeView({ data, sourcesFeed, now, source: sourceRef, show, health, snoozes, seenAt = null }: ViewProps) {
  const router = useRouter();
  const { sources } = data;
  const source = resolveSource(sources, sourceRef);
  // Inside one source its own state is the overview's header (itemsForSource), never a row and a tile again under it.
  const all = useMemo(() => itemsForSource(attentionItems(data, now, (s) => health.get(s._id)), source?._id ?? null), [data, now, health, source]);
  const { live, snoozed } = useMemo(() => splitSnoozed(all, snoozes, now), [all, snoozes, now]);
  const counts = useMemo(() => ({ ...attentionCounts(live), snoozed: snoozed.length }), [live, snoozed]);
  // Inside one source this list leads, under the header, and the overview's Open issues panel below it leaves out the issues listed here, so none shows twice.
  // Its Watches panel lists every watch worst first, and a replay row whose issue is open sits on that issue's row: neither repeats here.
  // What pages a person (the badge's count) always lists, so a red number on the tab is never without its rows and acts.
  const items = useMemo(() => (show === "snoozed" ? snoozed : live.filter((it) => admitsShow(it, show) && !(source && !show && onOverview(it) && !BADGE_STATES.has(it.state)))), [live, snoozed, show, source]);
  const sourceById = useMemo(() => new Map(sources.map((s) => [s._id, s])), [sources]);
  const groupById = useMemo(() => new Map(data.groups.map((g) => [g._id, g])), [data.groups]);
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState<Kind | null>(null);
  const shown = useMemo(() => (expanded ? items : items.slice(0, HOME_ROWS)), [expanded, items]);
  const here = opsHref.home({ source: source?.name ?? sourceRef, show });
  const clearHref = opsHref.home({ source: source?.name ?? sourceRef });
  // The watches the list already shows (alerting, erroring, blind behind a reader): the band leaves them out.
  const listedWatches = useMemo(() => new Set(live.flatMap((it) => (it.kind === "watch" ? [it.watch._id] : it.kind === "reader" ? it.watches.slice(0, it.blind).map((w) => w._id) : []))), [live]);
  // Watches blind behind a failing reader: the band counts them under Reader failing, the reader's own name, never as watch errors.
  const readerBlind = useMemo(() => new Set(live.flatMap((it) => (it.kind === "reader" ? it.watches.slice(0, it.blind).map((w) => w._id) : []))), [live]);
  // An issue opened from here walks this list with j and k, and Escape comes back to it (issueNav).
  const issueRefs = useMemo(() => homeIssueRefs(items), [items]);
  // The issues the list draws, the ones j and k walk and an issue page's "of N issues" counts: one number on both.
  // The issues in Needs attention as the Issues list counts them: the number the link beside the title opens to.
  const laneN = useMemo(() => attentionIssueCount(data.groups, now, data.failures, source?._id ?? null), [data.groups, data.failures, now, source?._id]);
  // Kept current while the list is on screen, so the walk is the order drawn now, even after a re-sort.
  useWatchEffect(() => rememberIssueList(issueRefs, here), [issueRefs, here]);

  // ── Triage: a cursor, a selection, and the keys that act on them ──
  const order = useMemo(() => shown.map((it) => it.key), [shown]);
  const [cursorKey, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const at = cursorKey ? order.indexOf(cursorKey) : -1;
  const current = at >= 0 ? shown[at] : null;
  const picked = useMemo(() => shown.filter((it) => selected.has(it.key)), [shown, selected]);
  const targets = (): AttentionItem[] => (picked.length ? picked : current ? [current] : []);
  const open = (it: AttentionItem) => {
    rememberIssueList(issueRefs, here);
    router.push(itemHref(it));
  };
  const toggle = (key: string, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = range ? rangeIds(order, anchor, key) : [key];
      const on = !prev.has(key);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
    setAnchor(key);
    setCursor(key);
  };
  const done = () => setSelected(new Set());
  const assignToMe = (its: AttentionItem[]) => {
    const id = (useInboxStore.getState().currentUser as { _id?: string } | null)?._id;
    if (id) assignItems(its, id, "you");
    done();
  };
  const snooze24 = (its: AttentionItem[]) => {
    snoozeItems(its, snoozeChoices(its[0].kind).find((c) => c.key === "24h") ?? null);
    done();
  };
  const resolve = (its: AttentionItem[]) => {
    resolveItems(its);
    done();
  };

  useWatchEffect(() => {
    if (!sources.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      const move = (to: number) => setCursor(order[Math.max(0, Math.min(order.length - 1, to))] ?? null);
      const its = targets();
      if (e.key === "j" || e.key === "ArrowDown") move(at + 1);
      else if (e.key === "k" || e.key === "ArrowUp") move(at < 0 ? 0 : at - 1);
      else if ((e.key === "Enter" || e.key === "o") && current) open(current);
      else if (e.key === "x" && current) toggle(current.key, e.shiftKey);
      else if (e.key === "e" && its.length) resolve(its);
      else if (e.key === "s" && its.length) snooze24(its);
      else if (e.key === "a" && its.length) assignToMe(its);
      else if (e.key === "f" && current) document.querySelector<HTMLButtonElement>(`[data-ops-item="${CSS.escape(itemRef(current))}"] [data-ops-fix-start]`)?.click();
      else if (e.key === "z" && !e.shiftKey) undoTriage();
      else if (e.key === "Escape" && selected.size) done();
      else return;
      e.preventDefault();
    };
    // Capture, so Escape clears a selection before the shell's go-up-a-level sees it (the shell steps aside for a handled key).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targets and open read these
  }, [order, at, current, picked, selected, anchor, sources.length, issueRefs, here]);
  // The cursor stays on screen as j and k walk past the fold.
  useWatchEffect(() => {
    if (cursorKey) document.querySelector<HTMLElement>('.ops-home-row[data-cursor="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [cursorKey]);
  // A selection keeps only rows still listed.
  useWatchEffect(() => setSelected((s) => (s.size && [...s].some((k) => !order.includes(k)) ? new Set([...s].filter((k) => order.includes(k))) : s)), [order]);

  const sheet = connecting ? <ConnectSheet key={connecting} kind={connecting} onClose={() => setConnecting(null)} /> : null;

  if (!sources.length) {
    if (sourcesFeed?.error) return <OpsFeedError what="sources" retry={sourcesFeed.retry} />;
    if (sourcesFeed && !sourcesFeed.ready) return <div className="ops-quiet text-[12.5px] py-16 text-center">Reading sources…</div>;
    return (
      <div className="ops-pad ops-home ops-home-first" data-ops-first-run data-sheet={connecting ? "true" : undefined}>
        <ConnectFirst picked={connecting} onPick={setConnecting} />
        {sheet}
      </div>
    );
  }

  // When anything was last heard: from this source alone inside its view, else from any.
  const checked = Math.max(0, ...(source ? [source] : sources).map((s) => health.get(s._id)?.lastAt ?? s.last_event_at ?? 0));
  const allTiles = [...ATTENTION_FILTERS, ...(snoozed.length || show === "snoozed" ? [{ key: "snoozed" as const, label: "Snoozed", tone: "calm" as const }] : [])];
  // Inside one source the strip keeps only the filters that hold something here (or are on); its red group sums to the Overview tab's badge.
  // Watch errors and degraded sources show only when there are some, so a workspace with none keeps the strip it knows.
  // A paging tile that holds nothing goes, as the watch band drops an empty state: the red group is only what pages now.
  const tiles = source ? allTiles.filter((f) => counts[f.key] > 0 || show === f.key) : allTiles.filter((f) => (!OCCASIONAL.has(f.key) && f.tone !== "bad") || counts[f.key] > 0 || show === f.key);
  const watches = source ? data.watches.filter((w) => w.source_id === source._id) : data.watches;
  const newCount = seenAt ? items.filter((it) => isNewSince(it, seenAt)).length : 0;
  const resolvable = resolvableGroups(picked).length;
  // The token says what its tile says, in the tile's own number (Reader failing, never a second name for it).
  const tileWords = (key: OpsHomeShow) => {
    const f = allTiles.find((t) => t.key === key);
    return f ? filterWords(f, counts[key]) : key;
  };
  const withTask = picked.filter((it) => it.task?.short_id).length;
  const paging = tiles.filter((f) => f.tone === "bad").reduce((n, f) => n + counts[f.key], 0);
  return (
    <div className="ops-pad ops-home" data-ops-home={show ?? "all"}>
      {sheet}
      {tiles.length > 0 && <div className="ops-home-strip" role="toolbar" aria-label="What is wrong">
        {/* The red tiles that page a person sit in one outlined group: their sum is the Overview tab's and the sidebar's count. */}
        {[tiles.filter((f) => f.tone === "bad"), tiles.filter((f) => f.tone !== "bad")].map((group, gi) => group.length > 0 && (
          <div key={gi} className="ops-home-tilegroup" data-paging={gi === 0 ? "true" : undefined} style={{ flexGrow: group.length }} title={gi === 0 ? `Paging: ${group.reduce((n, f) => n + counts[f.key], 0)}, the Overview tab's count` : undefined}>
            {group.map((f) => {
              const n = counts[f.key];
              const on = show === f.key;
              // A count of nothing says so in place: pressing it would only open an empty list.
              if (!n && !on) {
                return (
                  <span key={f.key} className="ops-home-count" data-tone="zero" aria-disabled="true" data-overlap={f.key === "unassigned" || f.key === "snoozed" ? "true" : undefined} data-ops-count={f.key} title={TILE_WINDOW[f.key]}>
                    <b className="ops-num">0</b>
                    <span>{filterWords(f, 0)}</span>
                  </span>
                );
              }
              return (
                <Link key={f.key} href={opsHref.home({ source: source?.name ?? sourceRef, show: on ? null : f.key })} className="ops-home-count" data-tone={n ? f.tone : "zero"} data-on={on ? "true" : undefined} data-overlap={f.key === "unassigned" || f.key === "snoozed" ? "true" : undefined} aria-pressed={on} data-ops-count={f.key} title={TILE_WINDOW[f.key]}>
                  <b className="ops-num">{n}</b>
                  <span>{filterWords(f, n)}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>}

      {/* The overview of one source lists its own watches; the band is the home's glance across all of them. */}
      {!show && !source && <WatchBand watches={watches} source={null} listed={listedWatches} readerBlind={readerBlind} />}

      {items.length ? (
        <div className="ops-home-table">
          {picked.length > 0 ? (
            <div className="iss-bulk ops-home-bulk" role="toolbar" aria-label="Selected" data-ops-bulk={picked.length}>
              <span className="ops-num"><b>{picked.length}</b> selected</span>
              <button type="button" className="ops-btn" disabled={!resolvable} onClick={() => resolve(picked)} data-ops-bulk-resolve><Check className="w-3.5 h-3.5" />Resolve{resolvable ? ` ${resolvable}` : ""}<KeyCap size="xs">e</KeyCap></button>
              <button type="button" className="ops-btn" onClick={() => snooze24(picked)} data-ops-bulk-snooze><Clock className="w-3.5 h-3.5" />Snooze 24h<KeyCap size="xs">s</KeyCap></button>
              <button type="button" className="ops-btn" disabled={!withTask} onClick={() => assignToMe(picked)} data-ops-bulk-assign><UserPlus className="w-3.5 h-3.5" />Assign me{withTask ? ` ${withTask}` : ""}<KeyCap size="xs">a</KeyCap></button>
              <span className="flex-1" />
              <button type="button" className="ops-btn" onClick={done}><X className="w-3.5 h-3.5" />Clear<KeyCap size="xs">esc</KeyCap></button>
            </div>
          ) : (
            <div className="ops-home-head">
              <span />
              <span className="ops-home-headtitle">
                {show === "snoozed" ? "Snoozed" : "Needs attention"} <span className="ops-num">{items.length}</span>
                {/* The Overview tab's and the sidebar's number is the paging part of this list: said beside it, not only on hover. */}
                {/* The rows in it that open an issue (one per folded cause), the count an issue opened from here steps through; watches, sources and the rest make up the remainder. */}
                {/* The Issues list's own Needs attention count (one per issue, variants and replay rows aside), the number that tab shows when this opens it. */}
                {!show && laneN > 0 && <Link href={opsHref.issues({ source: source?.name ?? sourceRef, lane: "attention" })} className="ops-link ops-home-lane" data-ops-attention-issues={laneN}>· <span className="ops-num">{laneN}</span> {laneN === 1 ? "issue" : "issues"}</Link>}
                {!show && paging > 0 && paging !== items.length && <span className="ops-home-paging" data-ops-paging={paging} title="Alerting, checks failing, regressed, escalating and sources down: the Overview tab's and the sidebar's count">· <b className="ops-num">{paging}</b> paging</span>}
                {show && <FilterToken label={tileWords(show)} href={clearHref} />}
                {show && TILE_LANE[show] && <Link href={opsHref.issues({ source: source?.name ?? sourceRef, lane: TILE_LANE[show] })} className="ops-link ops-home-lane" data-ops-lane-link={TILE_LANE[show]}>In Issues<ArrowUpRight className="w-3 h-3" aria-hidden /></Link>}
                {newCount > 0 && <span className="ops-home-newcount" data-ops-new-count={newCount}><i className="ops-home-newdot" />{newCount} new</span>}
              </span>
              <span data-col="spark">Last 24h</span>
              <span data-col="num" data-h="events" title="An issue's events since it opened: the Issues list's Count">Count</span>
              <span data-col="num" data-h="users" title="People an issue reached since it opened: the Issues list's Users">Users</span>
              <span data-col="num" title="When each went wrong: an alert's start, a regression, a spike's first hour, first seen, a reader's first failure">Started</span>
              <span className="ops-home-keys" data-col="keys"><KeyCap size="xs">j</KeyCap><KeyCap size="xs">k</KeyCap><KeyCap size="xs">x</KeyCap></span>
            </div>
          )}
          <ol className="ops-home-list" aria-label={show === "snoozed" ? "Snoozed" : "Needs attention"} aria-multiselectable data-selecting={picked.length ? "true" : undefined}>
            {shown.map((it) => (
              <AttentionRow
                key={it.key}
                item={it}
                source={it.sourceId ? sourceById.get(it.sourceId) : undefined}
                groupById={groupById}
                now={now}
                snoozedTill={show === "snoozed" ? snoozedUntil(it, snoozes) : undefined}
                isNew={isNewSince(it, seenAt)}
                cursor={it.key === cursorKey}
                selected={selected.has(it.key)}
                onOpen={() => open(it)}
                onSelect={(range) => toggle(it.key, range)}
                onPoint={() => setCursor(it.key)}
              />
            ))}
          </ol>
          {items.length > shown.length && (
            <button type="button" className="ops-home-more" onClick={() => setExpanded(true)} data-ops-show-all>
              Show all <span className="ops-num">{items.length.toLocaleString()}</span>
            </button>
          )}
        </div>
      ) : source && !show ? null : (
        <div className="ops-home-clear" data-ops-clear>
          <i aria-hidden />
          <span>{show ? `No ${tiles.find((f) => f.key === show)?.label.toLowerCase() ?? "items"} right now` : "All clear"}</span>
          {checked > 0 && <span className="ops-dim">last heard {relTimeShort(checked, now)}</span>}
          {show && <FilterToken label={tileWords(show)} href={clearHref} />}
        </div>
      )}

      {!source && <SourceHealthTable sources={sources} groups={data.groups} replays={data.replays} health={health} now={now} onAdd={() => setConnecting("sdk")} adding={!!connecting} />}
    </div>
  );
}

/** The filter that is on, as a token beside the count: pressing it shows everything again, as Escape does (the shell's go-up-a-level, opsUpHref). */
function FilterToken({ label, href }: { label: string; href: string }) {
  return (
    <Link href={href} className="ops-home-token" data-ops-filter-token title="Show everything">
      {label}
      <X className="w-3 h-3" aria-hidden />
      <KeyCap size="xs">esc</KeyCap>
    </Link>
  );
}

/** Tiles drawn only while they hold something (or are the filter on). */
const OCCASIONAL: ReadonlySet<OpsHomeShow> = new Set(["check", "reader", "erroring", "degraded"]);

/** What each tile counts, and over what window, on hover. */
const TILE_WINDOW: Record<OpsHomeShow, string> = {
  alerting: "Watches past their line now",
  check: "App checks failing now",
  regressed: "Issues that came back after a resolve, in the last 7d: the Issues list's Regressed lane",
  escalating: "Issues whose last 24h ran 3x their usual day or more: the Issues list's Escalating lane",
  new: "Issues first seen in the last 24h: the Issues list's New lane",
  firing: "Ongoing issues with 100+ events in the last 24h, still firing, and checks that keep failing: the Issues list's Firing lane",
  errors: "Replays from the last 24h with errors no listed issue covers, one row per issue they name",
  reader: "App readers that keep failing, with the watches that read through them",
  erroring: "Watches whose own query fails: blind until they read again",
  sources: "Sources stopped, disconnected or halted on an error: nothing comes through",
  degraded: "Sources still sending whose import, poll or actions fail, or whose poll runs late",
  unassigned: "Listed items nobody is working on",
  snoozed: "Snoozed or muted; each comes back when its time runs out or it gets worse",
};

// ── Source health ──

/**
 * Every source under the one health reading: its state and why, a week of
 * volume, its last event, its last 24 hours as its own overview totals them
 * (sourceLastDay) and its open issues by the Issues tab's own rule
 * (issueTotals, summed per source), so no number here disagrees with the page it links to.
 */
function SourceHealthTable({ sources, groups, replays, health, now, onAdd, adding }: { sources: OpsSource[]; groups: OpsGroup[]; replays: AttentionInput["replays"]; health: HealthMap; now: number; onAdd: () => void; adding: boolean }) {
  const rows = useMemo(() => sources.map((s) => ({ s, h: health.get(s._id) })).sort((a, b) => Number(healthBad(b.h)) - Number(healthBad(a.h)) || a.s.name.localeCompare(b.s.name)), [sources, health]);
  const capped = useMemo(() => openFeederFull(groups, OPS_OPEN_GROUPS_LIMIT), [groups]);
  return (
    <section className="ops-home-sources" aria-label="Sources">
      <div className="ops-home-sources-head">
        <span className="ops-section-label">Sources <span className="ops-num ops-dim">{sources.length}</span></span>
        {!adding && <button type="button" className="ops-btn" onClick={onAdd} data-ops-add-source><Plus className="w-3.5 h-3.5" />Add</button>}
      </div>
      <table className="ops-home-srctable">
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">State</th>
            <th scope="col" data-col="week">7 days</th>
            <th scope="col" data-num="">Last event</th>
            <th scope="col" data-num="" title="Events over the last 24 hours, rolling">24h</th>
            <th scope="col" data-num="">Open</th>
            <th scope="col" data-col="acts"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ s, h }) => {
            const bad = healthBad(h);
            const day = sourceLastDay(s._id, groups, replays, now);
            const last24 = eventsLast24h(s, groups, replays, now);
            const open = issueTotals(groups, sources, s._id, capped).open;
            const week = h?.days.slice(-7) ?? [];
            return (
              <tr key={s._id} data-bad={bad ? "true" : undefined} data-ops-source-row={s.name}>
                <th scope="row">
                  <Link href={opsHref.home({ source: s.name })} className="ops-home-srcname" title={`${SOURCE_PROVIDER_LABEL[s.provider]} · ${s.short_id}`}>
                    <ProviderIcon provider={s.provider} className="w-3.5 h-3.5" />
                    <span className="truncate">{s.name}</span>
                  </Link>
                </th>
                <td data-col="state">
                  <span className="ops-home-health" data-tone={h?.tone ?? "calm"}><i aria-hidden style={{ background: TONE_VAR[h?.tone ?? "calm"] }} />{h?.label ?? "—"}</span>
                  {bad && (h?.reason ?? s.last_error) ? <span className="ops-home-reason" title={h?.reason ?? s.last_error}>{h?.reason ?? s.last_error}</span> : null}
                </td>
                <td data-col="week">{week.some((n) => n > 0) ? <Spark values={week} bar={5} gap={2} height={16} tone={TONE_VAR[h?.tone === "ok" ? "calm" : h?.tone ?? "calm"]} label={`${s.name}, events per day over the last week`} /> : <span className="ops-dim">—</span>}</td>
                <td data-num="" className="ops-num ops-dim">{h?.lastAt ? relTimeShort(h.lastAt, now) : "never"}</td>
                <td data-num="" className="ops-num" data-ops-24h title={s.hours ? "Events over the last 24 hours, rolling: the overview's tile" : `${day.occurrences.toLocaleString()} occurrences, ${day.replays.toLocaleString()} replays`}>{last24.toLocaleString()}</td>
                <td data-num="" className="ops-num">{open ? <Link href={opsHref.tab("issues", { source: s.name })} className="ops-link" data-tone="bad">{open.toLocaleString()}</Link> : <span className="ops-dim">0</span>}</td>
                <td data-col="acts">
                  <div className="ops-home-srcacts">
                    {h && (bad || h.state === "paused") ? (h.fix === "setup" || !h.fix ? <Link href={opsHref.home({ source: s.name })} className="ops-btn" data-ops-fix="inspect">Inspect</Link> : <HealthFixButton source={s} health={h} />) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ── First run ──

/** Each kind of source a person can connect. GitHub installs an app, so it is the one tile that leaves for Settings. */
const CONNECT_TILES: { key: string; label: string; what: string; provider: OpsSource["provider"]; href?: string }[] = [
  { key: "posthog", label: "PostHog", what: "Replays, metrics", provider: "posthog" },
  { key: "sentry", label: "Sentry", what: "Errors", provider: "sentry" },
  { key: "app", label: "Your app", what: "Readers, actions, watches", provider: "app" },
  { key: "github", label: "GitHub CI", what: "Failed runs, deploys", provider: "github", href: "/settings/integrations#app-github" },
  { key: "sdk", label: "Ingest key", what: "Errors, jobs, checks, moments", provider: "sdk" },
];

function ConnectFirst({ picked, onPick }: { picked: Kind | null; onPick: (k: Kind) => void }) {
  return (
    <>
      <div className="ops-home-first-head">
        <Plug className="w-4 h-4" aria-hidden />
        <b>No sources connected</b>
      </div>
      <div className="ops-home-tiles">
        {CONNECT_TILES.map((t) => {
          const body = (
            <>
              <ProviderIcon provider={t.provider} className="w-5 h-5" />
              <b>{t.label}</b>
              <span className="ops-dim">{t.what}</span>
            </>
          );
          return t.href
            ? <Link key={t.key} href={t.href} className="ops-home-tile" data-ops-connect={t.key}>{body}</Link>
            : <button key={t.key} type="button" className="ops-home-tile" data-ops-connect={t.key} aria-pressed={picked === t.provider} data-on={picked === t.provider ? "true" : undefined} onClick={() => onPick(t.provider as Kind)}>{body}</button>;
        })}
      </div>
    </>
  );
}
