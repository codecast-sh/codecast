// The Issues tab: every group across the workspace's sources. The query
// (status, lane, kind, search, sort, facets, spark window) lives in the
// address, so a filtered list is a link. Open issues split into lanes, and
// the list opens on the ones that need a person now (regressed, escalating,
// new); quiet ones wait in their own lane. Rows can be selected (click the
// box, x, shift-click for a range) and resolved, ignored or handed to a fix
// session together, with an undo (z), or assigned (a). Each row shows its
// owner (the problem task's assignee), and Mine keeps the ones the viewer
// answers for. j and k move, Enter opens, / searches.
import { useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, Search, SlidersHorizontal, UserPlus, Wand2, X } from "lucide-react";
import type { GroupKind } from "@codecast/shared/contracts/ingest";
import { isRecordNotIssue } from "@codecast/shared/contracts/signalFingerprint";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { OPS_OPEN_GROUPS_LIMIT, useOpsEvents, useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches, useSyncOpsGroupSearch, useSyncOpsOlderGroups, useSyncOpsStatusGroups } from "../../hooks/useSyncOps";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { relTimeShort } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { opsHref, sourceConnectHref } from "./opsPaths";
import { KIND_LOOK, KindGlyph, OpsFeedEmpty, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, SourceChip, sourceFacts, useOpsFeed } from "./parts";
import type { OpsGroup, OpsSource } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  DEFAULT_QUERY,
  effectiveSort,
  countWords,
  countColumnLabel,
  FIX_STAGE_LABEL,
  resolverOf,
  FLAP_DAYS,
  FLAP_MIN,
  ISSUE_SORTS,
  LANE_FILTERS,
  LATEST_RELEASE,
  QUIET_DAYS,
  REGRESSED_DAYS,
  SPARK_RANGES,
  STATUS_FILTERS,
  facetOptions,
  facetRows,
  filterIssues,
  isFlapping,
  issueOwner,
  issueFixStage,
  issueOnIt,
  laneCount,
  laneOf,
  latestRelease,
  issueQueryParams,
  issueState,
  issueTotals,
  parseIssueQuery,
  regressedIn,
  usersCounted,
  usersOf,
  usersText,
  rangeIds,
  sharedTitleLeads,
  releaseOptions,
  releaseTimes,
  sparkSeries,
  statusAdmits,
  statusCounts,
  withPicked,
  withTotals,
  type FacetKey,
  type FixTask,
  type IssueCtx,
  type IssueCounts,
  type IssueQuery,
  type IssueLane,
  type IssueSort,
  type LaneFilter,
  type StatusFilter,
  knownRelease,
} from "./issuesModel";
import { useIssueFailures } from "./useOpsAttention";
import { FixReview, FixStageGlyph, IssueStatePill, LaneTag } from "./issueParts";
import { AssignMenu, OwnerFace } from "./issueOwner";
import { assignIssues, ownerInfo, useOwnerOptions, type OwnerOption } from "./issueAssign";
import { TRIAGE_CONFIRM_AT, setTaskStatusUndoable, triage, undoTriage } from "./issueUndo";
import { useFixSessions, useResolverWords } from "./useIssueFix";
import { issueListFocus, rememberIssueFocus, rememberIssueList } from "./issueNav";
import { HealthBadge, HealthFixButton } from "./SourceHealthParts";
import { useSourceHealth } from "./useSourceHealth";
import "./issues.css";

const ref = (g: OpsGroup) => g.short_id || g._id;
const isToggleInput = (t: EventTarget | null) => t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio");

type TaskFacts = FixTask & { _id: string; short_id?: string };
/** The fields of a problem task the fix chain reads, as a compact digest per task. */
const taskDigest = (t: TaskFacts | undefined) => (t ? `${t.status ?? ""}:${t.closed_at ?? ""}:${t.landed?.sha ?? ""}:${t.cause?.dissolved?.at ?? ""}:${t.assignee ?? ""}:${t.title?.length ?? 0}:${t.short_id ?? ""}` : "");

/** The problem tasks the rows name, read by a digest of the fields the fix chain weighs. */
function useTaskFacts(groups: OpsGroup[]): (id: string) => FixTask | undefined {
  const ids = useMemo(() => [...new Set(groups.map((g) => g.signal_task_id).filter(Boolean) as string[])], [groups]);
  const sig = useInboxStore((s) => ids.map((id) => taskDigest((s.tasks as Record<string, TaskFacts>)[id])).join(","));
  return useMemo(() => {
    const tasks = useInboxStore.getState().tasks as Record<string, TaskFacts>;
    const map = new Map(ids.map((id) => [id, tasks[id]]));
    return (id: string) => map.get(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the task rows
  }, [ids, sig]);
}

export function IssuesTab({ source }: { source: string | null }) {
  // A record is never an issue (a CI run filed as its own group, a check that never failed); the server's lists and counts leave them out too.
  const stored = useOpsGroups();
  const all = useMemo(() => stored.filter((g) => !isRecordNotIssue(g)), [stored]);
  const sources = useOpsSources();
  const events = useOpsEvents();
  const feed = useOpsFeed("groups");
  const now = useCoarseNow(60_000);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = useMemo(() => parseIssueQuery((k) => params.get(k)), [params]);
  // Settled statuses and search reach past the windows the shell feeds: the server answers them into the same store.
  const wide = query.status === "all";
  useSyncOpsStatusGroups(query.status === "resolved" || wide ? "resolved" : null);
  useSyncOpsStatusGroups(query.status === "ignored" || wide ? "ignored" : null);
  useSyncOpsStatusGroups(query.status === "ignored" || wide ? "muted" : null);
  useSyncOpsGroupSearch(query.q);
  const sourceById = useMemo(() => new Map(sources.map((s) => [s._id, s])), [sources]);
  const sourceRow = source ? sources.find((s) => s.name === source) : undefined;
  const sourceId = sourceRow?._id;
  const taskStatus = useTaskFacts(all);
  // A check or metric's flips over the events this device holds: the count the Overview's lanes read too.
  const failures = useIssueFailures(now);
  const times = useMemo(() => releaseTimes(all, events, sourceId), [all, events, sourceId]);
  const latest = useMemo(() => latestRelease(times, all.filter((g) => !sourceId || g.source_id === sourceId).flatMap((g) => [g.last_release, g.first_release].filter(Boolean) as string[])), [times, all, sourceId]);
  const me = useInboxStore((s) => ((s as any).currentUser?._id as string | undefined) ?? null);
  const owners = useOwnerOptions();
  const ctx = useMemo<IssueCtx>(() => ({ sourceId, taskStatus, failures, latestRelease: latest, me }), [sourceId, taskStatus, failures, latest, me]);

  const groups = useMemo(() => filterIssues(all, query, ctx, now), [all, query, ctx, now]);
  // Nobody on it: the rows the rest of the query admits that no session, worked task or assignee covers, the count the Overview's tile reads by the same rule.
  const nobodyCount = useMemo(() => (query.nobody ? groups.length : filterIssues(all, { ...query, nobody: true }, ctx, now).length), [all, query, ctx, now, groups]);
  // The fix sessions the shown rows started, so a row whose agent is working now says so.
  const fixIds = useMemo(() => [...new Set(groups.map((g) => g.fix_conversation_id).filter(Boolean) as string[])], [groups]);
  const fixSessions = useFixSessions(fixIds, now);
  const awake = useMemo(() => new Set(fixSessions.filter((s) => s.awake).map((s) => s.id)), [fixSessions]);
  // The open feeder stops at its cap: past it the sources' own counts say how many there are (issueTotals), and the badge reads the same.
  const openCapped = useMemo(() => all.filter((g) => g.status === "open").length >= OPS_OPEN_GROUPS_LIMIT, [all]);
  const totals = useMemo(() => issueTotals(all, sources, sourceId ?? null, openCapped), [all, sources, sourceId, openCapped]);
  const counts = useMemo(() => {
    const held = statusCounts(all, query, ctx, now);
    const unfiltered = !query.q.trim() && !query.kind && !query.mine && !Object.values(query.facets).some(Boolean);
    if (!unfiltered) return held;
    let oldest: number | null = null;
    for (const g of all) if (g.status === "open" && (!sourceId || g.source_id === sourceId) && (oldest === null || g.last_seen < oldest)) oldest = g.last_seen;
    return withTotals(held, totals, oldest, now);
  }, [all, query, ctx, now, totals, sourceId]);
  const openFloor = !totals.exact && !query.q.trim();
  // The rows of this status the store holds, against how many exist: past the feeders' windows the list pages back on a press.
  const pageStatus = query.status === "all" ? null : query.status === "ignored" ? "ignored" : query.status === "resolved" ? "resolved" : "open";
  const held = useMemo(() => {
    let n = 0;
    let oldest: number | null = null;
    if (pageStatus) for (const g of all) if ((!sourceId || g.source_id === sourceId) && statusAdmits(pageStatus, g)) {
      n++;
      if (oldest === null || g.last_seen < oldest) oldest = g.last_seen;
    }
    return { n, oldest };
  }, [all, pageStatus, sourceId]);
  const unheld = pageStatus && totals.exact ? Math.max(0, totals[pageStatus] - held.n) : 0;
  const [olderThan, setOlderThan] = useState<number | null>(null);
  const older = useSyncOpsOlderGroups(pageStatus === "ignored" ? "ignored" : pageStatus ?? "open", pageStatus ? olderThan : null);
  // Every facet counts over what the rest of the query admits, so an option's count is what picking it shows.
  const facetData = useMemo(() => {
    const over = (key: Parameters<typeof facetRows>[4]) => facetRows(all, query, ctx, now, key);
    const kindCounts = new Map<string, number>();
    for (const g of over("kind")) kindCounts.set(g.kind, (kindCounts.get(g.kind) ?? 0) + 1);
    const sourceCounts = new Map<string, number>();
    for (const g of over("source")) sourceCounts.set(g.source_id, (sourceCounts.get(g.source_id) ?? 0) + 1);
    return {
      kinds: [...kindCounts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
      levels: facetOptions(over("level"), "level", ctx),
      types: facetOptions(over("type"), "type", ctx),
      releases: releaseOptions(facetOptions(over("release"), "release", ctx), times),
      fixes: facetOptions(over("fix"), "fix", ctx),
      sourceCounts,
    };
  }, [all, query, ctx, now, times]);
  // Which facets the list has at all, whatever the status: the bar keeps that shape when the status changes, and a facet with nothing to pick under this status is disabled, never removed.
  const facetShape = useMemo(() => {
    const q = { ...query, status: "all" as const, lane: "all" as const };
    const over = (key: Parameters<typeof facetRows>[4]) => facetRows(all, q, ctx, now, key);
    return {
      kind: new Set(over("kind").map((g) => g.kind)).size > 1,
      level: facetOptions(over("level"), "level", ctx).length > 1,
      type: facetOptions(over("type"), "type", ctx).length > 0,
      release: facetOptions(over("release"), "release", ctx).length > 0,
      fix: facetOptions(over("fix"), "fix", ctx).length > 1,
    };
  }, [all, query, ctx, now]);
  const order = useMemo(() => groups.map(ref), [groups]);

  const [focusId, setFocusId] = useState<string | null>(() => issueListFocus());
  const focus = Math.max(0, focusId ? order.indexOf(focusId) : 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [fixFor, setFixFor] = useState<OpsGroup[] | null>(null);
  const [assignFor, setAssignFor] = useState<OpsGroup[] | null>(null);
  const [sheet, setSheet] = useState(false);
  // A triage over many rows waits for its count to be confirmed.
  const [confirm, setConfirm] = useState<"resolved" | "ignored" | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const setQuery = (patch: Partial<IssueQuery>) => {
    const next = { ...query, ...patch, facets: { ...query.facets, ...(patch.facets ?? {}) } };
    for (const k of Object.keys(next.facets) as FacetKey[]) if (!next.facets[k]) delete next.facets[k];
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(issueQueryParams(next))) {
      if (v) qs.set(k, v);
      else qs.delete(k);
    }
    router.replace(`${pathname}?${qs.toString()}`, { scroll: false });
  };
  const filtered = query.q.trim() !== "" || !!query.kind || Object.keys(query.facets).length > 0 || query.mine || !!query.nobody;

  // The page walks the list it came from, and comes back to it focused where it left.
  useWatchEffect(() => {
    rememberIssueList(order, `${pathname}?${params.toString()}`);
  }, [order, pathname, params]);
  useWatchEffect(() => setSelected((s) => (s.size ? new Set([...s].filter((id) => order.includes(id))) : s)), [order]);

  const open = (g: OpsGroup) => {
    rememberIssueFocus(ref(g));
    router.push(opsHref.issue(ref(g)));
  };
  const targets = (): OpsGroup[] => (selected.size ? groups.filter((g) => selected.has(ref(g))) : groups[focus] ? [groups[focus]] : []);
  const setStatus = (rows: OpsGroup[], status: "resolved" | "ignored" | "open", confirmed = false) => {
    if (!confirmed && status !== "open" && rows.length > TRIAGE_CONFIRM_AT) return setConfirm(status);
    setConfirm(null);
    triage(rows, status);
    setSelected(new Set());
  };
  const toggle = (id: string, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = range ? rangeIds(order, anchor, id) : [id];
      const on = !prev.has(id);
      for (const x of ids) on ? next.add(x) : next.delete(x);
      return next;
    });
    setAnchor(id);
  };

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      // A row's or the header's checkbox holds no caret: a key right after a click on one is the list's.
      if (isEditableTarget(e.target) && !isToggleInput(e.target)) {
        if (e.key === "Escape" && e.target === searchRef.current) {
          e.preventDefault();
          searchRef.current?.blur();
        }
        if ((e.key === "ArrowDown" || e.key === "Enter") && e.target === searchRef.current) {
          searchRef.current?.blur();
          if (e.key === "Enter" && groups[0]) setFocusId(ref(groups[0]));
        }
        return;
      }
      const g = groups[focus];
      const move = (to: number) => setFocusId(order[Math.max(0, Math.min(order.length - 1, to))] ?? null);
      if (confirm && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        if (e.key === "Enter") setStatus(targets(), confirm, true);
        else setConfirm(null);
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") move(focus + 1);
      else if (e.key === "k" || e.key === "ArrowUp") move(focus - 1);
      else if ((e.key === "Enter" || e.key === "o") && g) open(g);
      else if (e.key === "/") searchRef.current?.focus();
      else if (e.key === "x" && g) toggle(ref(g), e.shiftKey);
      else if (e.key === "e" && targets().length) setStatus(targets(), "resolved");
      else if (e.key === "i" && targets().length) setStatus(targets(), "ignored");
      else if (e.key === "f" && targets().length) setFixFor(targets());
      else if (e.key === "a" && targets().length) setAssignFor(targets());
      else if (e.key === "z" && !e.shiftKey) undoTriage();
      else if (e.key === "Escape" && selected.size) setSelected(new Set());
      else return;
      e.preventDefault();
    };
    // Capture, so Escape clears a selection before the shell's go-up-a-level
    // sees it (the shell steps aside for a handled key). With nothing selected
    // the key passes through and goes up as usual.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [groups, order, focus, selected, anchor, confirm]);
  // j and k can walk past the fold: keep the focused row on screen.
  useWatchEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>("[data-focused]")?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  // `?preview=empty` and `?preview=nosources` draw the empty states over this workspace, without switching teams, so they can be checked live.
  const preview = params.get("preview");
  // Every hook runs before the early returns below, so a list that fills in after an empty first render keeps one hook order.
  // Titles that open the same way as another shown row lead with what tells them apart.
  const leads = useMemo(() => sharedTitleLeads(groups), [groups]);
  // The sources that send people at all: a row of one that does not says so on hover; every surface draws an unknown count as one dash.
  const peopleSources = useMemo(() => new Set(all.filter((g) => (g.users ?? 0) > 0).map((g) => g.source_id)), [all]);
  if (all.length === 0 || preview === "empty" || preview === "nosources") return <IssuesEmpty feed={feed} sources={preview === "nosources" ? [] : sources} />;
  // A source that never produced an issue is its own state, not a finished triage.
  if (sourceRow && feed?.ready && !sourceRow.groups_open && !all.some((g) => g.source_id === sourceRow._id)) return <SourceNoIssues source={sourceRow} />;

  const { kinds, levels, types, releases, fixes, sourceCounts } = facetData;
  const allSelected = groups.length > 0 && groups.every((g) => selected.has(ref(g)));
  const sortBy = (s: IssueSort) => setQuery({ sort: s });
  // People are counted only where a source sends who hit it; with none counted the column and its sort would do nothing.
  const showUsers = usersCounted(groups);
  const activeFacets = (query.kind ? 1 : 0) + Object.values(query.facets).filter(Boolean).length;
  const clearAll = () => setQuery({ ...DEFAULT_QUERY, status: query.status, lane: query.lane, sort: query.sort, range: query.range, facets: { level: "", type: "", release: "", fix: "" }, mine: false, nobody: false });
  const pickOwner = (o: OwnerOption) => {
    if (assignFor) assignIssues(assignFor, o, sourceById);
    setAssignFor(null);
    setSelected(new Set());
  };
  const facetEls = (
    <>
      {(kinds.length > 1 || query.kind || facetShape.kind) && (
        <FacetSelect disabled={kinds.length <= 1 && !query.kind} label="Kind" value={query.kind ?? ""} onChange={(v) => setQuery({ kind: (v || null) as GroupKind | null })} options={withPicked(kinds, query.kind ?? undefined, (value) => ({ value, count: 0 })).map((k) => ({ value: k.value, label: KIND_LOOK[k.value as GroupKind]?.label ?? k.value, count: k.count }))} />
      )}
      {(levels.length > 1 || query.facets.level || facetShape.level) && <FacetSelect disabled={levels.length <= 1 && !query.facets.level} label="Level" value={query.facets.level ?? ""} onChange={(v) => setQuery({ facets: { level: v } })} options={withPicked(levels, query.facets.level, (value) => ({ value, count: 0 })).map((o) => ({ value: o.value, label: o.value, count: o.count }))} />}
      {(types.length > 0 || query.facets.type || facetShape.type) && <FacetSelect disabled={types.length === 0 && !query.facets.type} label="Type" value={query.facets.type ?? ""} onChange={(v) => setQuery({ facets: { type: v } })} options={withPicked(types, query.facets.type, (value) => ({ value, count: 0 })).map((o) => ({ value: o.value, label: o.value.replace(/_/g, " "), count: o.count }))} />}
      {(releases.length > 0 || query.facets.release || facetShape.release) && (
        <FacetSelect
          disabled={releases.length === 0 && !query.facets.release}
          label="Release"
          value={query.facets.release ?? ""}
          onChange={(v) => setQuery({ facets: { release: v } })}
          options={[
            ...(latest ? [{ value: LATEST_RELEASE, label: `latest · ${latest.slice(0, 9)}${times.get(latest) ? ` · ${relTimeShort(times.get(latest)!, now)}` : ""}` }] : []),
            ...withPicked(releases, query.facets.release === LATEST_RELEASE ? undefined : query.facets.release, (value) => ({ value, count: 0, at: times.get(value) ?? null }))
              .slice(0, 60)
              .map((o) => ({ value: o.value, label: `${o.value.length > 14 ? o.value.slice(0, 12) + "…" : o.value}${o.at ? ` · ${relTimeShort(o.at, now)}` : ""}`, count: o.count })),
          ]}
        />
      )}
      {!source && sources.length > 1 && (
        <FacetSelect
          label="Source"
          value=""
          onChange={(v) => v && router.push(`${opsHref.tab("issues", { source: v })}&${new URLSearchParams(Object.entries(issueQueryParams(query)).filter(([, x]) => x) as [string, string][]).toString()}`)}
          options={sources.map((s) => ({ value: s.name, label: s.name, count: sourceCounts.get(s._id) ?? 0 })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))}
        />
      )}
      {(fixes.length > 1 || query.facets.fix || facetShape.fix) && <FacetSelect disabled={fixes.length <= 1 && !query.facets.fix} label="Fix" value={query.facets.fix ?? ""} onChange={(v) => setQuery({ facets: { fix: v } })} options={withPicked(fixes, query.facets.fix, (value) => ({ value, count: 0 })).map((o) => ({ value: o.value, label: FIX_STAGE_LABEL[o.value as keyof typeof FIX_STAGE_LABEL] ?? o.value, count: o.count }))} />}
      {filtered && <button type="button" className="iss-clear" onClick={clearAll}>Clear</button>}
    </>
  );
  const sortEl = <FacetSelect label="Sort" value={effectiveSort(query)} always onChange={(v) => sortBy((v || "urgency") as IssueSort)} options={ISSUE_SORTS.filter((s) => (showUsers || s.key !== "users" || query.sort === "users") && (s.key !== "urgency" || query.status === "open")).map((s) => ({ value: s.key, label: s.label }))} />;

  return (
    <div className="ops-pad iss-list">
      <div className="iss-toolbar">
        <label className="iss-search">
          <Search className="w-3.5 h-3.5 ops-dim" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query.q}
            placeholder="Search issues"
            aria-label="Search issues"
            onChange={(e) => setQuery({ q: e.target.value })}
          />
          {query.q ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery({ q: "" })}><X className="w-3 h-3" /></button>
          ) : (
            <KeyCap size="xs">/</KeyCap>
          )}
        </label>
        <div className="ops-seg iss-status-seg" role="group" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} type="button" data-on={query.status === f.key ? "true" : undefined} data-status={f.key} aria-pressed={query.status === f.key} onClick={() => setQuery({ status: f.key })}>
              {f.label}
              <span className="iss-seg-n ops-num" title={openFloor && f.key === "open" ? `at least ${counts.open.toLocaleString()}; the newest ${OPS_OPEN_GROUPS_LIMIT} open are loaded` : undefined}>{counts[f.key].toLocaleString()}{openFloor && f.key === "open" && counts.open > 0 ? "+" : ""}</span>
            </button>
          ))}
        </div>
        {me && (
          <button type="button" className="iss-mine" aria-pressed={query.mine} data-on={query.mine ? "true" : undefined} onClick={() => setQuery({ mine: !query.mine })} title="Only issues whose problem task you own">
            Mine
          </button>
        )}
        {(query.status === "open" || query.nobody) && (
          <button type="button" className="iss-mine iss-nobody" aria-pressed={!!query.nobody} data-on={query.nobody ? "true" : undefined} data-zero={nobodyCount === 0 ? "true" : undefined} onClick={() => setQuery({ nobody: !query.nobody })} title="No fix session, no task being worked and nobody assigned">
            <span className="iss-nobody-ring" aria-hidden /> Nobody on it <span className="iss-seg-n ops-num">{nobodyCount.toLocaleString()}</span>
          </button>
        )}
        <CountSelect className="iss-status-pick" label="Status" value={query.status} onChange={(v) => setQuery({ status: v as StatusFilter })} options={STATUS_FILTERS.map((f) => ({ value: f.key, label: f.label, count: counts[f.key] }))} />
        {facetEls}
        <button type="button" className="ops-btn iss-filters-btn" aria-expanded={sheet} onClick={() => setSheet((v) => !v)}>
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters{activeFacets ? ` (${activeFacets})` : ""}
        </button>
        <div className="flex-1" />
        {sortEl}
        <div className="ops-seg iss-spark-win" role="group" aria-label="Spark window">
          {SPARK_RANGES.map((r) => (
            <button key={r} type="button" data-on={query.range === r ? "true" : undefined} aria-pressed={query.range === r} onClick={() => setQuery({ range: r })}>{r}</button>
          ))}
        </div>
      </div>

      {query.status === "open" && <LaneBar lane={query.lane} counts={counts} onPick={(lane) => setQuery({ lane })} />}

      {sheet && (
        <div className="iss-sheet" role="group" aria-label="Filters">
          {facetEls}
          {sortEl}
        </div>
      )}

      {confirm ? (
        <div className="iss-bulk" role="alertdialog" aria-label="Confirm" data-confirm="true">
          <span className="ops-num">{confirm === "resolved" ? "Resolve" : "Ignore"} <b>{targets().length.toLocaleString()}</b> issues?</span>
          <button type="button" className="ops-btn" data-tone="primary" autoFocus onClick={() => setStatus(targets(), confirm, true)}>
            {confirm === "resolved" ? "Resolve" : "Ignore"} {targets().length.toLocaleString()} <KeyCap size="xs" tone="onAccent">Enter</KeyCap>
          </button>
          <button type="button" className="ops-btn" onClick={() => setConfirm(null)}>Cancel <KeyCap size="xs">esc</KeyCap></button>
        </div>
      ) : selected.size > 0 && (
        <div className="iss-bulk" role="toolbar" aria-label="Selected issues">
          <span className="ops-num"><b>{selected.size}</b> selected</span>
          <button type="button" className="ops-btn" onClick={() => setStatus(targets(), "resolved")}><Check className="w-3.5 h-3.5" /> Resolve <KeyCap size="xs">e</KeyCap></button>
          <button type="button" className="ops-btn" onClick={() => setStatus(targets(), "ignored")}>Ignore <KeyCap size="xs">i</KeyCap></button>
          {query.status !== "open" && <button type="button" className="ops-btn" onClick={() => setStatus(targets(), "open")}>Reopen</button>}
          <span className="iss-assign-anchor">
            <button type="button" className="ops-btn" aria-expanded={!!assignFor} onClick={() => setAssignFor(assignFor ? null : targets())}><UserPlus className="w-3.5 h-3.5" /> Assign <KeyCap size="xs">a</KeyCap></button>
            {assignFor && <AssignMenu options={owners} onPick={pickOwner} onClose={() => setAssignFor(null)} />}
          </span>
          <button type="button" className="ops-btn" onClick={() => setFixFor(targets())}><Wand2 className="w-3.5 h-3.5" /> Start fix <KeyCap size="xs">f</KeyCap></button>
          <div className="flex-1" />
          <button type="button" className="ops-btn" onClick={() => setSelected(new Set())}>Clear <KeyCap size="xs">esc</KeyCap></button>
        </div>
      )}

      {groups.length === 0 ? (
        <NoneShown query={query} counts={counts} filtered={filtered} source={source} clearAll={clearAll} setQuery={setQuery} />
      ) : (
        <div className="iss-table" role="table" aria-label="Issues" aria-rowcount={groups.length} data-users={showUsers ? undefined : "false"} data-selecting={selected.size > 0 ? "true" : undefined}>
          <div className="iss-row iss-head" role="row">
            <span role="columnheader" className="iss-c-sel">
              <input type="checkbox" aria-label="Select every issue shown" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(order))} />
            </span>
            <span role="columnheader" className="iss-c-kind" />
            <span role="columnheader" className="iss-c-title">Issue <span className="ops-dim ops-num">{groups.length.toLocaleString()}</span></span>
            <span role="columnheader" className="iss-c-spark">Last {query.range}</span>
            <SortHead className="iss-c-events" label={countColumnLabel(groups)} sort="events" current={effectiveSort(query)} onSort={sortBy} />
            <SortHead className="iss-c-users" label="Users" sort="users" current={effectiveSort(query)} onSort={sortBy} />
            <SortHead className="iss-c-seen" label="Seen" sort="last" current={effectiveSort(query)} onSort={sortBy} />
            <span role="columnheader" className="iss-c-fix">Fix</span>
            <span role="columnheader" className="iss-c-status">Status</span>
          </div>
          <div ref={bodyRef} role="rowgroup">
            {groups.map((g, i) => (
              <IssueRow
                key={g._id}
                group={g}
                now={now}
                range={query.range}
                focused={i === focus}
                selected={selected.has(ref(g))}
                source={sourceById.get(g.source_id)}
                countsPeople={peopleSources.has(g.source_id)}
                lead={leads.get(g._id) ?? 0}
                stage={issueFixStage(g, ctx)}
                onIt={issueOnIt(g, ctx)}
                agentAwake={!!g.fix_conversation_id && awake.has(g.fix_conversation_id)}
                lane={laneOf(g, now, ctx)}
                flaps={failures(g)}
                owner={ownerInfo(owners, issueOwner(g, ctx))}
                release={issueState(g) === "regressed" ? regressedIn(g, events) : null}
                task={g.signal_task_id ? (ctx.taskStatus(g.signal_task_id) as TaskFacts | string | undefined) : undefined}
                onOpen={() => open(g)}
                onSelect={(e) => toggle(ref(g), e.shiftKey)}
              />
            ))}
          </div>
        </div>
      )}

      {unheld > 0 && !filtered && groups.length > 0 && (query.status !== "open" || query.lane === "all" || query.lane === "quiet") && (
        <div className="iss-older ops-num">
          <span className="ops-dim">{held.n.toLocaleString()} of {totals[pageStatus!].toLocaleString()} {pageStatus}</span>
          {olderThan !== null && olderThan === held.oldest && older.ready ? (
            <span className="ops-dim">End of list</span>
          ) : (
            <button type="button" className="ops-btn" data-size="sm" disabled={olderThan !== null && olderThan === held.oldest} aria-busy={olderThan !== null && olderThan === held.oldest && !older.ready} onClick={() => setOlderThan(held.oldest)}>
              Load {Math.min(unheld, OPS_OPEN_GROUPS_LIMIT).toLocaleString()} older
            </button>
          )}
        </div>
      )}

      <div className="iss-keys ops-dim">
        <KeyCap size="xs">j</KeyCap><KeyCap size="xs">k</KeyCap> move <KeyCap size="xs">Enter</KeyCap> open <KeyCap size="xs">x</KeyCap> select <KeyCap size="xs">e</KeyCap> resolve <KeyCap size="xs">i</KeyCap> ignore <KeyCap size="xs">a</KeyCap> assign <KeyCap size="xs">z</KeyCap> undo <KeyCap size="xs">f</KeyCap> fix <KeyCap size="xs">/</KeyCap> search
      </div>

      {assignFor && !selected.size && (
        <div className="iss-assign-float">
          <span className="ops-dim">Assign {assignFor.map(ref).slice(0, 2).join(", ")}{assignFor.length > 2 ? "…" : ""}</span>
          <AssignMenu options={owners} onPick={pickOwner} onClose={() => setAssignFor(null)} />
        </div>
      )}
      {fixFor && <FixReview groups={fixFor} source={sourceById.get(fixFor[0].source_id)} onClose={() => setFixFor(null)} onStarted={() => setSelected(new Set())} />}
    </div>
  );
}

function SortHead({ label, sort, current, onSort, className }: { label: string; sort: IssueSort; current: IssueSort; onSort: (s: IssueSort) => void; className: string }) {
  return (
    <span role="columnheader" className={className} aria-sort={current === sort ? "descending" : "none"}>
      <button type="button" className="iss-sort" data-on={current === sort ? "true" : undefined} onClick={() => onSort(sort)}>
        {label}{current === sort ? " ↓" : ""}
      </button>
    </span>
  );
}

const LANE_HINT: Partial<Record<LaneFilter, string>> = {
  attention: "regressed, escalating or new",
  regressed: `back after a resolve, in the last ${REGRESSED_DAYS} days`,
  flapping: `failed ${FLAP_MIN}+ times in ${FLAP_DAYS} days`,
  quiet: `nothing in ${QUIET_DAYS} days`,
};

/** The lanes of an open list with their counts; at narrow widths, one select. */
function LaneBar({ lane, counts, onPick }: { lane: LaneFilter; counts: IssueCounts; onPick: (l: LaneFilter) => void }) {
  return (
    <div className="iss-lanes" role="group" aria-label="Lane">
      <div className="iss-lane-tabs">
        {/* The lanes partition Open and sum to it; Flapping cuts across them (a flapper may read resolved between flips), so it stands apart. */}
        {[...LANE_FILTERS.filter((f) => f.key !== "flapping" && f.key !== "all"), ...LANE_FILTERS.filter((f) => f.key === "flapping" || f.key === "all")].map((f) => (
          <button key={f.key} type="button" data-lane={f.key} data-apart={f.key === "flapping" ? "true" : undefined} data-on={lane === f.key ? "true" : undefined} aria-pressed={lane === f.key} data-zero={laneCount(counts, f.key) === 0 ? "true" : undefined} onClick={() => onPick(f.key)} title={LANE_HINT[f.key]}>
            {f.label}
            <span className="iss-seg-n ops-num">{laneCount(counts, f.key).toLocaleString()}</span>
          </button>
        ))}
      </div>
      <CountSelect className="iss-lane-pick" label="Lane" value={lane} onChange={(v) => onPick(v as LaneFilter)} options={LANE_FILTERS.map((f) => ({ value: f.key, label: f.label, count: laneCount(counts, f.key) }))} />
    </div>
  );
}

/** A segment folded into a select for a narrow pane: each option carries its count. */
function CountSelect({ label, value, options, onChange, className }: { label: string; value: string; options: { value: string; label: string; count: number }[]; onChange: (v: string) => void; className: string }) {
  return (
    <label className={`iss-facet ${className}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}  {o.count.toLocaleString()}</option>)}
      </select>
    </label>
  );
}

/** Nothing matches: say what is empty, and offer the lists that do hold issues. */
function NoneShown({ query, counts, filtered, source, clearAll, setQuery }: { query: IssueQuery; counts: IssueCounts; filtered: boolean; source: string | null; clearAll: () => void; setQuery: (p: Partial<IssueQuery>) => void }) {
  const inLane = query.status === "open" && query.lane !== "all";
  const what = inLane
    ? query.lane === "attention" ? "Nothing regressed, escalating or new" : `No ${LANE_FILTERS.find((f) => f.key === query.lane)?.label.toLowerCase()} issues`
    : `No ${query.status === "all" ? "" : STATUS_FILTERS.find((f) => f.key === query.status)?.label.toLowerCase()} issues`;
  const others = inLane ? LANE_FILTERS.filter((f) => f.key !== query.lane && f.key !== "attention" && f.key !== "all" && laneCount(counts, f.key) > 0) : [];
  return (
    <div className="iss-none">
      <div className="text-[13px] text-sol-text">{what}{query.q ? ` matching “${query.q}”` : ""}{source ? ` on ${source}` : ""}</div>
      <div className="flex gap-2 justify-center flex-wrap mt-3">
        {filtered && <button type="button" className="ops-btn" onClick={clearAll}>Clear filters</button>}
        {others.map((f) => <button key={f.key} type="button" className="ops-btn" onClick={() => setQuery({ lane: f.key })}>{f.label} <span className="ops-num ops-dim">{laneCount(counts, f.key).toLocaleString()}</span></button>)}
        {inLane && counts.open > 0 && <button type="button" className="ops-btn" onClick={() => setQuery({ lane: "all" })}>All open <span className="ops-num ops-dim">{counts.open.toLocaleString()}</span></button>}
        {!inLane && query.status !== "all" && counts.all > 0 && <button type="button" className="ops-btn" onClick={() => setQuery({ status: "all" })}>All <span className="ops-num ops-dim">{counts.all.toLocaleString()}</span></button>}
      </div>
    </div>
  );
}

function FacetSelect({ label, value, options, onChange, always, disabled }: { label: string; value: string; options: { value: string; label: string; count?: number }[]; onChange: (v: string) => void; always?: boolean; /** Nothing to pick under this status: kept in place, inert. */ disabled?: boolean }) {
  return (
    <label className="iss-facet" data-on={value && !always ? "true" : undefined} data-disabled={disabled ? "true" : undefined}>
      <span className="ops-dim">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={disabled}>
        {!always && <option value="">any</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}{o.count !== undefined ? `  ${o.count}` : ""}</option>
        ))}
      </select>
    </label>
  );
}

function IssueRow({ group: g, now, range, focused, selected, source, countsPeople, lead, stage, onIt, agentAwake, lane, flaps, owner, release, task, onOpen, onSelect }: {
  /** Someone is on it (someoneOnIt): an open row nobody is on shows the empty ring. */
  onIt: boolean;
  /** The fix session started from this issue is working now. */
  agentAwake: boolean;
  group: OpsGroup;
  /** Characters of the title another shown row shares, drawn dim. */
  lead: number;
  /** Its source sends people with its events. */
  countsPeople: boolean;
  task?: TaskFacts | string;
  now: number;
  range: IssueQuery["range"];
  focused: boolean;
  selected: boolean;
  source?: OpsSource;
  stage: ReturnType<typeof issueFixStage>;
  lane: IssueLane | null;
  flaps: number;
  owner: OwnerOption | null;
  release: string | null;
  onOpen: () => void;
  onSelect: (e: MouseEvent) => void;
}) {
  const series = useMemo(() => sparkSeries(g, now, range), [g, now, range]);
  const daily = range === "30d";
  const state = issueState(g);
  const resolvedBy = useResolverWords(state === "resolved" ? resolverOf(g) : { via: null }, g.external?.provider);
  const closable = state === "resolved" && typeof task === "object" && task.short_id && (stage === "filed" || stage === "review") ? task : null;
  // An open issue nobody is on: the Overview's Nobody on it, drawn as an empty ring where an owner's face would be.
  const nobody = g.status === "open" && !onIt;
  const tone = state === "regressed" ? "var(--sol-orange)" : state === "open" ? "var(--sol-red)" : "var(--sol-text-muted)";
  return (
    <div
      className="iss-row"
      role="row"
      data-row
      data-focused={focused ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-state={state}
      data-lane={lane ?? undefined}
      aria-label={`${g.short_id} ${g.title}`}
      aria-selected={selected}
      tabIndex={0}
      onClick={(e) => (e.shiftKey || e.metaKey ? onSelect(e) : onOpen())}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen();
      }}
    >
      <span className="iss-c-sel" role="cell" onClick={(e) => { e.stopPropagation(); onSelect(e); }}>
        <input type="checkbox" checked={selected} readOnly tabIndex={-1} aria-label={`Select ${g.short_id}`} />
      </span>
      <span className="iss-c-kind" role="cell"><KindGlyph kind={g.kind} /></span>
      <span className="iss-c-title" role="cell">
        <span className="iss-title" title={g.title}>
          {lead > 0 ? <><span className="iss-title-lead">{g.title.slice(0, lead)}</span>{g.title.slice(lead)}</> : g.title}
        </span>
        <span className="iss-sub">
          <LaneTag lane={lane} group={g} now={now} />
          <span className="ops-mono">{g.short_id}</span>
          {source ? <span className="iss-sub-src"><ProviderIcon provider={source.provider} />{source.name}</span> : null}
          {knownRelease(g.last_release) ? <span className="ops-mono iss-sub-rel">{knownRelease(g.last_release)}</span> : null}
          {g.culprit ? <span className="ops-mono iss-sub-cut">{g.culprit}</span> : null}
          <span className="iss-narrow-meta ops-num">
            <span>{relTimeShort(g.last_seen, now)}</span>
            <span>{g.count.toLocaleString()} {countWords(g.kind, g.count).short ?? "ev"}</span>
            {usersOf(g) ? <span className="iss-narrow-users">{usersText(usersOf(g)!)}</span> : null}
            {stage !== "none" ? <span className="iss-narrow-fix" data-stage={stage}>{FIX_STAGE_LABEL[stage]}{agentAwake ? <span className="iss-live-dot" aria-label="agent working now" /> : null}</span> : null}
            {nobody ? <span className="iss-narrow-nobody">nobody on it</span> : null}
          </span>
        </span>
      </span>
      <span className="iss-c-spark" role="cell">
        <Spark values={series} bar={range === "72h" ? 1.5 : 3.5} gap={0.5} height={18} tone={tone} stretch className="w-full" label={`${g.short_id}, per ${daily ? "day" : "hour"} over ${range}`} />
      </span>
      <span className="iss-c-events ops-num" role="cell" title={`${g.count.toLocaleString()} ${countWords(g.kind, g.count).long}`}>{g.count.toLocaleString()}{countWords(g.kind, g.count).short && <span className="iss-unit"> {countWords(g.kind, g.count).short}</span>}</span>
      <span className="iss-c-users ops-num" role="cell" title={g.users_since ? `counted since ${new Date(g.users_since).toLocaleDateString()}` : !usersOf(g) && !countsPeople ? `${source?.name ?? "its source"} sends no people` : undefined}>
        {usersOf(g) ? usersText(usersOf(g)!, false) : <span className="ops-dim">–</span>}
      </span>
      <span className="iss-c-seen ops-num ops-quiet" role="cell" title={`last ${new Date(g.last_seen).toLocaleString()}, first ${new Date(g.first_seen).toLocaleString()}`}>{relTimeShort(g.last_seen, now)}</span>
      <span className="iss-c-fix" role="cell">
        {/* A dropped fix is a decision someone made: it opens the issue's Fix card, where the task and its Refile are. */}
        {stage === "dropped" ? (
          <Link href={`${opsHref.issue(g.short_id || g._id)}#iss-fix`} className="iss-fix-open" onClick={(e) => e.stopPropagation()} title="Open the dropped task, or refile it" data-ops-fix-dropped>
            <FixStageGlyph stage={stage} word />
          </Link>
        ) : closable ? (
          // A resolved issue whose task still waits: the cell says its stage like every other row, and closing it is one press beside the word, z undoes it.
          <>
            <FixStageGlyph stage={stage} word />
            <button type="button" className="iss-fix-open iss-fix-close" onClick={(e) => { e.stopPropagation(); setTaskStatusUndoable({ short_id: closable.short_id!, status: closable.status }, "done"); }} title={`${closable.short_id} is still ${FIX_STAGE_LABEL[stage].toLowerCase()}: close it`} aria-label={`Close ${closable.short_id}`} data-ops-fix-close>
              <Check className="w-3 h-3" aria-hidden />
            </button>
          </>
        ) : (
          <>
            <FixStageGlyph stage={stage} word />
            {agentAwake && <span className="iss-live-dot" title="The fix session is working now" aria-label="agent working now" />}
          </>
        )}
        {nobody && !owner ? <span className="iss-nobody-ring" title="Nobody on it: no fix session, no task being worked, nobody assigned" aria-label="nobody on it" data-ops-nobody /> : <OwnerFace owner={owner} />}
      </span>
      <span className="iss-c-status" role="cell"><IssueStatePill group={g} release={release} now={now} flaps={isFlapping(g, flaps) ? flaps : undefined} row stage={stage} resolvedBy={resolvedBy} /></span>
    </div>
  );
}

/** No groups at all: whether anything is connected, and if so, what each source last sent. */
export function IssuesEmpty({ feed, sources }: { feed: ReturnType<typeof useOpsFeed>; sources: OpsSource[] }) {
  if (!feed?.ready || feed.error) return <OpsFeedEmpty feeds={[feed]} what="issues" title="No issues" />;
  if (sources.length === 0) {
    return (
      <div className="iss-empty">
        <div className="text-[14px] text-sol-text font-medium">No sources connected</div>
        <div className="iss-providers">
          {(["sentry", "posthog", "app", "github", "sdk"] as const).map((p) => (
            <a key={p} href={sourceConnectHref(p)} className="iss-provider" data-provider={p}><ProviderIcon provider={p} className="w-4 h-4" />{p === "sdk" ? "Ingest key" : p === "github" ? "GitHub CI" : SOURCE_PROVIDER_LABEL[p]}</a>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="iss-empty">
      <div className="text-[14px] text-sol-text font-medium">No issues yet</div>
      <div className="iss-quiet-sources">
        {sources.map((s) => (
          <div key={s._id} className="iss-quiet-source">
            <SourceChip source={s} href={opsHref.tab("timeline", { source: s.name })} />
            <span className="ops-dim text-[11.5px] truncate">{sourceFacts(s).join(" · ")}</span>
          </div>
        ))}
      </div>
      <a href={SETUP_HREF} className="ops-btn">Sources</a>
    </div>
  );
}

/**
 * A source that has never produced an issue: its health first (with the
 * press that fixes it when something is wrong), then where its data does
 * land, each a count that opens the tab holding it. Not "all clear": a
 * source that sends moments or replays never makes issues at all.
 */
function SourceNoIssues({ source }: { source: OpsSource }) {
  const health = useSourceHealth(source);
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  const now = useCoarseNow(60_000);
  const nReplays = replays.filter((r) => r.source_id === source._id).length;
  const nWatches = watches.filter((w) => w.source_id === source._id).length;
  const days = source.days ?? [];
  const nEvents = days.reduce((a, d) => a + d.events, 0);
  const lands = [
    { tab: "timeline" as const, label: "Timeline", n: nEvents, unit: "events, 30d" },
    { tab: "replays" as const, label: "Replays", n: nReplays, unit: nReplays === 1 ? "replay" : "replays" },
    { tab: "metrics" as const, label: "Metrics", n: nWatches, unit: nWatches === 1 ? "watch" : "watches" },
  ].filter((l) => l.n > 0);
  const bad = health && (health.tone === "bad" || health.tone === "warn");
  return (
    <div className="ops-pad iss-list">
      <div className="iss-src-empty" data-bad={bad ? "true" : undefined}>
        <div className="iss-src-empty-head">
          <ProviderIcon provider={source.provider} className="w-4 h-4" />
          <span className="text-[14px] text-sol-text font-medium">{source.name}</span>
          {health && <HealthBadge health={health} />}
          <span className="ops-num ops-dim text-[12px]">0 issues</span>
        </div>
        <dl className="iss-src-facts ops-num">
          <dt>last event</dt>
          <dd>{health?.lastAt ?? source.last_event_at ? `${relTimeShort((health?.lastAt ?? source.last_event_at)!, now)} ago` : "never"}</dd>
          {health?.polledAt ? (<><dt>last poll</dt><dd>{relTimeShort(health.polledAt, now)} ago</dd></>) : null}
          {bad && health?.reason ? (<><dt>problem</dt><dd className="iss-src-reason" title={health.reason}>{health.reason}</dd></>) : null}
        </dl>
        {lands.length > 0 && (
          <div className="iss-src-lands">
            {lands.map((l) => (
              <a key={l.tab} href={opsHref.tab(l.tab, { source: source.name })} className="iss-src-land">
                <span className="iss-src-land-k">{l.label}</span>
                <span className="ops-num"><b>{l.n.toLocaleString()}</b> <span className="ops-dim">{l.unit}</span></span>
              </a>
            ))}
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          {health && bad && <HealthFixButton source={source} health={health} primary />}
          <a href={opsHref.home({ source: source.name })} className="ops-btn" data-tone={bad ? undefined : "primary"}>Open {source.name}</a>
        </div>
      </div>
    </div>
  );
}
