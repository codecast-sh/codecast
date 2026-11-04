// The Replays tab: the workspace's recordings as a list a person narrows to
// the one they need. Search (person, page, rp-N), toggles for errors, failed
// requests and rage clicks, length and date, a sort, and a fold by person.
// The filter lives in the address, so a filtered list can be shared. The
// server's browse (convex replays.browse) runs the filter over every
// recording and counts the matches; its rows land in the store, and the list
// paints from the store with the same filter (shared/replay/list.ts), so a
// cached page shows at once and "Show more" only adds rows.
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronUp, Copy, Search, SlidersHorizontal, UserCheck, Users, X } from "lucide-react";
import { copyText } from "../../lib/copyText";
import { REPLAY_ACTIVE, REPLAY_ACTIVE_DEFAULT, type ReplayActive, activeMsOf, anonHandle, replayPeople, sortPeople, compareReplays, personKey, personLabel, isAnonymous, replayMatches, exactReplayId, resolveReplayFilter, REPLAY_BROWSE_SCAN, REPLAY_DATES, REPLAY_DURATIONS, REPLAY_ENV_KEYS, REPLAY_HAS, REPLAY_SORTS, formatReplayTime, routeOf, type ReplayEnvKey, type ReplayHas, type ReplayPeopleSort, type ReplayPerson, type ReplaySort } from "@codecast/shared/replay";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpsGroups, useOpsReplays, useOpsReplayTally, useOpsSources, useSyncOpsReplayBrowse } from "../../hooks/useSyncOps";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { relTimeShort } from "../../lib/utils";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { opsHref } from "./opsPaths";
import { OpsFeedError, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, pressable } from "./parts";
import { OpsNotFound } from "./OpsShellParts";
import type { OpsGroup, OpsReplay, OpsSource } from "./opsTypes";
import { ReplayImportLine, hasVendorRecordings, isImportDismissed } from "./ReplayImport";
import { EnvMarks, PersonMark, ReplayFigures, ReplayStrip } from "./replayParts";
import { ReplayPreview } from "./ReplayPreview";
import { replayTotalText, useReplayTotal } from "./useReplayTotals";
import {
  DATE_LABEL,
  DUR_LABEL,
  ACTIVE_LABEL,
  ENV_LABEL,
  HAS_LABEL,
  PEOPLE_PAGE,
  REPLAY_PAGE,
  SORT_LABEL,
  coarseHour,
  figuresWidthPx,
  importedUntil,
  isReplayFiltered,
  issueTitleParts,
  pagePathParts,
  osName,
  parseReplayQuery,
  pathOf,
  peopleSortFor,
  replayPagePath,
  plural,
  replayLengthText,
  replayQueryParams,
  restHold,
  restLine,
  restState,
  restQueued,
  spanText,
  totalText,
  type ReplayListQuery,
} from "./replayModel";
import { laneOf } from "./issuesModel";
import "./replays.css";

const SEARCH_SETTLE_MS = 250;

export function ReplaysTab({ source }: { source: string | null }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const query = useMemo(() => parseReplayQuery((k) => params.get(k)), [params]);
  const now = useCoarseNow(60_000);
  const hour = coarseHour(now);
  const groups = useOpsGroups();
  // An issue filter names the issue by its short id; the recordings name it by group id.
  const issueGroupId = query.issue ? (groups.find((g) => g.short_id === query.issue)?._id ?? `unknown:${query.issue}`) : undefined;
  const match = useMemo(() => resolveReplayFilter({ ...query, group_id: issueGroupId }, hour), [query, hour, issueGroupId]);
  const sort: ReplaySort = query.sort ?? "newest";
  const filtered = isReplayFiltered(query);

  // Each filter starts at one page; "Show more" grows it.
  const [limit, setLimit] = useState(REPLAY_PAGE);
  const filterSig = JSON.stringify([source, match, sort]);
  useWatchEffect(() => setLimit(REPLAY_PAGE), [filterSig]);
  const grouped = query.group === "person" && !query.person;
  const peopleSort = peopleSortFor(query);
  const [peopleLimit, setPeopleLimit] = useState(PEOPLE_PAGE);
  useWatchEffect(() => setPeopleLimit(PEOPLE_PAGE), [filterSig, peopleSort, query.identified]);
  const peopleAsk = useMemo(() => (grouped ? { sort: peopleSort, limit: peopleLimit, identified: !!query.identified } : undefined), [grouped, peopleSort, peopleLimit, query.identified]);

  const browse = useMemo(() => ({ source, match, sort, limit, people: peopleAsk }), [source, match, sort, limit, peopleAsk]);
  const { key, feed } = useSyncOpsReplayBrowse(browse);
  const tally = useOpsReplayTally(key);
  const all = useOpsReplays();
  const rows = useMemo(
    () => all.filter((r) => (!source || r.source_name === source) && replayMatches(r, match)).sort(compareReplays(sort)),
    [all, source, match, sort],
  );
  const shown = rows.slice(0, limit);
  const figsW = useMemo(() => figuresWidthPx(shown), [rows, limit]); // eslint-disable-line react-hooks/exhaustive-deps -- shown is rows cut at limit
  const scopeCount = useMemo(() => (source ? all.filter((r) => r.source_name === source).length : all.length), [all, source]);
  // Until the server's count for this filter lands, the rows already cached stand in for it, shown as provisional.
  // An exact answer is the server's count, the one the person card and the import line print; only a capped scan's floor may be raised by rows already here.
  const total = tally ? (tally.capped ? Math.max(tally.total, rows.length) : tally.total) : rows.length;
  const counting = !tally;
  // A capped scan makes the total a floor. An exact rp-N, one person and the partly imported are read by index, so their counts are exact unless the server says capped.
  // The server reads one person and the partly imported by their own index, so its capped flag is the truth for them too.
  const floorOnly = !!tally?.capped && !exactReplayId(query.q);
  // One source records everything here: a Source column would repeat its name on every row.
  const oneSource = !source && new Set(all.map((r) => r.source_name ?? r.provider)).size <= 1;
  const groupById = useMemo(() => new Map(groups.map((g) => [g._id, g])), [groups]);
  const sources = useOpsSources();
  const importable = useMemo(() => sources.filter((s) => hasVendorRecordings(s) && (!source || s.name === source)), [sources, source]);

  const setQuery = (patch: Partial<ReplayListQuery>) => {
    const next = { ...query, ...patch };
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(replayQueryParams(next))) {
      if (v) qs.set(k, v);
      else qs.delete(k);
    }
    router.replace(`${pathname}?${qs.toString()}`, { scroll: false });
  };
  const clear = () => setQuery({ q: "", person: undefined, has: [], dur: undefined, date: undefined, active: undefined, issue: undefined, browser: undefined, os: undefined, device: undefined, country: undefined });
  const active = query.active ?? REPLAY_ACTIVE_DEFAULT;
  // The issues the recordings here caught, most caught first: the Issue picker's options. No count beside them: the loaded rows are not
  // the set the list and the issue page count over (useIssueReplayTotal), and the list under the pick says the real one.
  const issueOptions = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of all) if (!source || r.source_name === source) for (const id of r.group_ids) by.set(id, (by.get(id) ?? 0) + 1);
    return [...by.entries()]
      .map(([id, n]) => [groupById.get(id), n] as const)
      .filter((x): x is readonly [OpsGroup, number] => !!x[0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([g]) => ({ value: g.short_id, label: `${g.short_id} ${g.title.length > 48 ? `${g.title.slice(0, 47)}…` : g.title}` }));
  }, [all, source, groupById]);
  const pickEnv = (k: ReplayEnvKey, v: string) => setQuery({ [k]: v });
  const facets = tally?.facets;

  // The search box is typed into locally and reaches the address once typing pauses.
  const [text, setText] = useState(query.q ?? "");
  useWatchEffect(() => setText(query.q ?? ""), [query.q]);
  useWatchEffect(() => {
    if (text === (query.q ?? "")) return;
    const id = setTimeout(() => setQuery({ q: text }), SEARCH_SETTLE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settles on the text alone
  }, [text]);

  const [focus, setFocus] = useState(0);
  // The hover preview: a row held under the pointer for a moment (or Space on the focused row) plays its page in a card.
  const [preview, setPreview] = useState<{ id: string; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRow = (r: OpsReplay, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPreview({ id: r._id, rect: el.getBoundingClientRect() }), PREVIEW_DWELL_MS);
  };
  const leaveRow = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setPreview(null);
  };
  useWatchEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [preview]);
  useWatchEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Until the server's people for this filter land, the people in the rows already cached stand in, shown as provisional.
  const localPeople = useMemo(
    () => (grouped && !tally ? sortPeople(replayPeople(query.identified ? rows.filter((r) => !isAnonymous(r.user)) : rows), peopleSort).slice(0, peopleLimit) : null),
    [grouped, tally, rows, query.identified, peopleSort, peopleLimit],
  );
  const people = tally?.people ?? localPeople;
  const open = (r: OpsReplay) => router.push(opsHref.replay(r.short_id || r._id));
  const pickPerson = (key: string) => setQuery({ person: key, group: null });
  const count = grouped ? (people?.length ?? 0) : shown.length;

  useWatchEffect(() => setFocus(0), [filterSig, grouped]);
  useWatchEffect(() => setPreview((cur) => (cur && shown[focus]?._id !== cur.id ? null : cur)), [focus]);
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      if (isEditableTarget(e.target)) {
        if (e.target === searchRef.current && (e.key === "Escape" || e.key === "ArrowDown" || e.key === "Enter")) {
          searchRef.current?.blur();
          setFocus(0);
          e.preventDefault();
        }
        return;
      }
      const move = (to: number) => setFocus(Math.max(0, Math.min(count - 1, to)));
      if (e.key === "j" || e.key === "ArrowDown") move(focus + 1);
      else if (e.key === "k" || e.key === "ArrowUp") move(focus - 1);
      else if (e.key === "Enter" || e.key === "o") {
        if (grouped) people?.[focus] && pickPerson(people[focus].key);
        else if (shown[focus]) open(shown[focus]);
      } else if (e.key === " " && !grouped && shown[focus]) {
        const el = bodyRef.current?.querySelector<HTMLElement>("[data-row][data-focused='true']");
        setPreview((cur) => (cur?.id === shown[focus]._id || !el ? null : { id: shown[focus]._id, rect: el.getBoundingClientRect() }));
      } else if (e.key === "/") searchRef.current?.focus();
      else if (e.key === "Escape" && filtered) clear();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, count, grouped, people, shown, filtered]);
  useWatchEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>("[data-focused='true']");
    el?.scrollIntoView({ block: "nearest" });
    // A row that holds the keyboard's focus (reached by Tab) hands it on with j/k, so one row reads as selected.
    const held = document.activeElement;
    if (el && held instanceof HTMLElement && held !== el && held.matches("[data-row]") && bodyRef.current?.contains(held)) el.focus({ preventScroll: true });
  }, [focus]);

  // A put-away import still shows while copies are cut short: that count is the state of the recordings, not of the run.
  const visibleImports = importable.filter((s) => !isImportDismissed(s) || (s.replay_rest?.cut ?? 0) > 0);
  const [moreOpen, setMoreOpen] = useState(false);

  // Nothing recorded anywhere in this scope: say which sources can feed replays.
  if (!filtered && scopeCount === 0 && (tally?.total ?? 0) === 0) {
    if (feed.error) return <div className="ops-pad"><OpsFeedError what="replays" retry={feed.retry} /></div>;
    // A scope whose sources cannot record (CI, an app connector, moments, an ingest key) is empty without asking.
    const scoped = source ? sources.filter((s) => s.name === source) : sources;
    const canRecord = scoped.length === 0 || scoped.some(canRecordReplays);
    if (!feed.ready && canRecord) return <ListSkeleton />;
    // A source that can never record (CI, an app connector, moments) points at the ones that do, rather than offering recorders.
    const elsewhere = source && !canRecord ? sources.filter((s) => s.name !== source && canRecordReplays(s)) : [];
    if (source && elsewhere.length) return <ReplaysElsewhere source={scoped[0] ?? null} name={source} sources={elsewhere} />;
    return <ReplaysEmpty sources={source ? sources.filter((s) => s.name === source) : sources} />;
  }

  const personToken = query.person ? rows.find((r) => personKey(r.user) === query.person)?.user ?? null : null;
  const moreSet = [query.issue, query.date, ...REPLAY_ENV_KEYS.map((k) => query[k])].filter(Boolean).length;

  return (
    <div className="ops-pad rp-list" data-ops-replays>
      {visibleImports.length > 0 && (
        <div className="rp-imports" data-ops-replay-imports>
          {visibleImports.map((s) => <ReplayImportLine key={s._id} source={s} showName dismissible />)}
        </div>
      )}

      <div className="rp-toolbar" role="search">
        <label className="rp-search">
          <Search className="w-3.5 h-3.5 ops-dim" aria-hidden />
          <input ref={searchRef} type="search" value={text} placeholder="Person, page, request or rp-N" aria-label="Search recordings" onChange={(e) => setText(e.target.value)} />
          {text ? <button type="button" aria-label="Clear search" onClick={() => { setText(""); setQuery({ q: "" }); }}><X className="w-3 h-3" /></button> : <KeyCap size="xs">/</KeyCap>}
        </label>
        <div className="rp-chips" role="group" aria-label="Only recordings with">
          {REPLAY_HAS.map((h) => {
            const on = query.has?.includes(h) ?? false;
            return (
              <button key={h} type="button" className="rp-chip" data-has={h} data-on={on ? "true" : undefined} aria-pressed={on} onClick={() => setQuery({ has: on ? query.has!.filter((x) => x !== h) : [...(query.has ?? []), h] as ReplayHas[] })}>
                {HAS_LABEL[h]}
                {on && h === "rage" && (tally?.rage_unchecked ?? 0) > 0 && (
                  <span className="rp-chip-note ops-num" title={`${tally!.rage_unchecked!.toLocaleString()} recordings have no activity read yet, so the filter cannot test them`}>{tally!.rage_unchecked!.toLocaleString()} unchecked</span>
                )}
              </button>
            );
          })}
        </div>
        <Picker label="Length" value={query.dur ?? ""} options={REPLAY_DURATIONS.map((d) => ({ value: d, label: DUR_LABEL[d] }))} onChange={(v) => setQuery({ dur: (v || undefined) as ReplayListQuery["dur"] })} />
        <Picker label="Active" value={active} always on={active !== REPLAY_ACTIVE_DEFAULT} options={REPLAY_ACTIVE.map((a) => ({ value: a, label: ACTIVE_LABEL[a] }))} onChange={(v) => setQuery({ active: v as ReplayActive })} />
        {/* The rarer filters (issue, date, where it ran) wait behind one toggle; any that is set stays out, so the list's state is always on screen. */}
        <button type="button" className="rp-chip rp-more" aria-expanded={moreOpen} data-on={moreOpen ? "true" : undefined} onClick={() => setMoreOpen((v) => !v)}>
          <SlidersHorizontal className="w-3 h-3" aria-hidden /> More
          {moreSet > 0 && <span className="ops-num rp-more-n">{moreSet}</span>}
          {moreOpen ? <ChevronUp className="w-3 h-3" aria-hidden /> : <ChevronDown className="w-3 h-3" aria-hidden />}
        </button>
        <Picker label="Sort" value={sort} always options={REPLAY_SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))} onChange={(v) => setQuery({ sort: v as ReplaySort })} />
        <div className="ops-seg rp-group" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={!grouped} data-on={!grouped ? "true" : undefined} onClick={() => setQuery({ group: null })}>Recordings</button>
          <button type="button" role="radio" aria-checked={grouped} data-on={grouped ? "true" : undefined} disabled={!!query.person} onClick={() => setQuery({ group: "person" })}><Users className="w-3 h-3 inline -mt-px mr-1" aria-hidden />People</button>
        </div>
        <span className="rp-total ops-num" aria-live="polite" aria-busy={counting} data-provisional={counting ? "true" : undefined} title={counting ? "Counting every recording that matches" : undefined}>
          {grouped
            ? counting ? (localPeople?.length ? plural(localPeople.length, "person", "people") : "Counting people") : totalText(tally.people_total, tally.capped, REPLAY_BROWSE_SCAN, "person", "people")
            : counting && !exactReplayId(query.q) ? `${replayTotalText({ total, capped: total > 0 })} recordings` : totalText(total, floorOnly, REPLAY_BROWSE_SCAN)}
          {!grouped && active !== "any" && (tally?.below_active ?? 0) > 0 && (
            <button type="button" className="rp-total-below" onClick={() => setQuery({ active: "any" })} title={`Show the ${tally!.below_active!.toLocaleString()} recordings with under ${active} of activity too`}>
              +{tally!.below_active!.toLocaleString()} under {active} active
            </button>
          )}
        </span>
        {(moreOpen || moreSet > 0) && (
          <div className="rp-more-row" role="group" aria-label="More filters">
            {(issueOptions.length > 0 || query.issue) && (moreOpen || !!query.issue) && (
              <Picker label="Issue" value={query.issue ?? ""} options={query.issue && !issueOptions.some((o) => o.value === query.issue) ? [{ value: query.issue, label: query.issue }, ...issueOptions] : issueOptions} onChange={(v) => setQuery({ issue: v || undefined })} />
            )}
            {(moreOpen || !!query.date) && <Picker label="Started" value={query.date ?? ""} options={REPLAY_DATES.map((d) => ({ value: d, label: `Last ${DATE_LABEL[d]}` }))} onChange={(v) => setQuery({ date: (v || undefined) as ReplayListQuery["date"] })} />}
            {facets && REPLAY_ENV_KEYS.map((k) => {
              // A picker shows once the recordings say something for it; a value set from the address stays listed.
              const opts = facets[k] ?? [];
              if (!opts.length && !query[k]) return null;
              if (!moreOpen && !query[k]) return null;
              const listed = query[k] && !opts.some(([v]) => v === query[k]) ? [[query[k]!, 0] as [string, number], ...opts] : opts;
              return <Picker key={k} label={ENV_LABEL[k]} value={query[k] ?? ""} options={listed.map(([v, n]) => ({ value: v, label: `${k === "os" ? osName(v) : v}${n ? ` · ${n.toLocaleString()}` : ""}` }))} onChange={(v) => setQuery({ [k]: v || undefined })} />;
            })}
          </div>
        )}
      </div>

      {(query.person || filtered) && (
        <div className="rp-tokens">
          {query.person && (
            <span className="rp-token">
              <PersonMark label={personToken ? personLabel(personToken) : query.person} personKey={query.person} anonymous={personToken ? isAnonymous(personToken) : false} size={16} />
              {personToken ? personLabel(personToken) : query.person}
              <button type="button" aria-label="Show everyone" onClick={() => setQuery({ person: undefined })}><X className="w-3 h-3" /></button>
            </span>
          )}
          {filtered && <button type="button" className="rp-clear" onClick={clear}>Clear filters <KeyCap size="xs">Esc</KeyCap></button>}
        </div>
      )}

      <div ref={bodyRef} className="rp-wrap">
        {grouped ? (
          <PeopleList
            people={people}
            total={tally?.people_total ?? localPeople?.length ?? 0}
            anonymous={tally?.people_anonymous ?? null}
            ready={!!tally || !!localPeople?.length}
            focus={focus}
            onPick={pickPerson}
            now={now}
            sort={peopleSort}
            onSort={(s) => setQuery({ people_sort: s })}
            identified={!!query.identified}
            onIdentified={(on) => setQuery({ identified: on || undefined })}
            onMore={() => setPeopleLimit((n) => n + PEOPLE_PAGE)}
          />
        ) : shown.length === 0 ? (
          feed.ready || tally ? (
            exactReplayId(query.q) && tally && !isReplayFiltered({ ...query, q: "" }) && !query.person ? (
              <OpsNotFound id={exactReplayId(query.q)!} kind="replay" />
            ) : (
            <div className="rp-none">
              <b>{tally?.capped ? `No match in the newest ${REPLAY_BROWSE_SCAN.toLocaleString()} recordings` : "No recordings match"}</b>
              {active !== "any" && !exactReplayId(query.q) && <button type="button" className="ops-btn" onClick={() => setQuery({ active: "any" })}>Include under {active} active</button>}
              {filtered && <button type="button" className="ops-btn" onClick={clear}>Clear filters</button>}
            </div>
            )
          ) : (
            <ListSkeleton bare />
          )
        ) : (
          <div className="rp-table" role="table" aria-label="Recordings" data-scoped={source || oneSource ? "true" : undefined} style={{ "--rp-figs-w": `${figsW}px` } as CSSProperties}>
            <div className="rp-row rp-head" role="row" data-issues={shown.some((r) => r.group_ids.length) ? undefined : "none"}>
              <span role="columnheader" className="rp-c-mark" />
              <span role="columnheader" className="rp-c-who">Person · page</span>
              <SortHead className="rp-c-strip" label="Activity" sorts={["clicks"]} sort={sort} onSort={(s) => setQuery({ sort: s })} />
              <SortHead className="rp-c-len" label="Length" sorts={["longest"]} sort={sort} onSort={(s) => setQuery({ sort: s })} />
              <SortHead className="rp-c-figs" label="Events" sorts={["errors"]} sort={sort} onSort={(s) => setQuery({ sort: s })} />
              <span role="columnheader" className="rp-c-issue">Issues</span>
              {!source && !oneSource && <span role="columnheader" className="rp-c-src">Source</span>}
              <SortHead className="rp-c-age" label="Started" sorts={["newest", "oldest"]} sort={sort} onSort={(s) => setQuery({ sort: s })} />
            </div>
            {shown.map((r, i) => (
              <ReplayRow key={r._id} replay={r} now={now} floor={match.active_min_ms ?? 0} floorText={active} focused={i === focus} scoped={!!source || oneSource} groupById={groupById} onOpen={() => open(r)} onFocus={() => setFocus(i)} onPerson={pickPerson} onEnv={pickEnv} onHover={(el) => hoverRow(r, el)} onLeave={leaveRow} />
            ))}
          </div>
        )}
        {!grouped && shown.length > 0 && (
          <div className="rp-more">
            <span className="ops-dim ops-num">{shown.length.toLocaleString()} of {total.toLocaleString()}{floorOnly && total > 0 ? "+" : ""}</span>
            {(rows.length > shown.length || (tally && tally.total > shown.length)) && (
              <button type="button" className="ops-btn" onClick={() => setLimit((n) => n + REPLAY_PAGE)}>Show {Math.min(REPLAY_PAGE, total - shown.length).toLocaleString()} more</button>
            )}
          </div>
        )}
      </div>
      {preview && (() => {
        const r = shown.find((x) => x._id === preview.id);
        return r ? <ReplayPreview key={r._id} replay={r} anchor={preview.rect} /> : null;
      })()}
    </div>
  );
}

/** How long the pointer rests on a row before its preview opens: long enough that sweeping across the list opens none. */
const PREVIEW_DWELL_MS = 650;

function SortHead({ label, sorts, sort, onSort, className }: { label: string; sorts: ReplaySort[]; sort: ReplaySort; onSort: (s: ReplaySort) => void; className: string }) {
  const on = sorts.includes(sort);
  // A two-way column (Started) flips between its sorts; a one-way column sorts its way, and a second press goes back to newest.
  const next = sorts.length > 1 ? (on ? sorts[(sorts.indexOf(sort) + 1) % sorts.length] : sorts[0]) : on ? "newest" : sorts[0];
  return (
    <span role="columnheader" className={className} aria-sort={on ? (sort === "oldest" ? "ascending" : "descending") : "none"}>
      <button type="button" className="rp-sort" data-on={on ? "true" : undefined} onClick={() => onSort(next)}>
        {label}
        {on && (sort === "oldest" ? <ChevronUp className="w-3 h-3" aria-hidden /> : <ChevronDown className="w-3 h-3" aria-hidden />)}
      </button>
    </span>
  );
}

function Picker({ label, value, options, onChange, always, on }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; always?: boolean; on?: boolean }) {
  return (
    <label className="rp-picker" data-on={on ?? (value && !always) ? "true" : undefined}>
      <span className="ops-dim">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {!always && <option value="">Any</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ReplayRow({ replay: r, now, floor, floorText, focused, scoped, groupById, onOpen, onFocus, onPerson, onEnv, onHover, onLeave }: {
  replay: OpsReplay;
  now: number;
  /** The list's active-time floor (0 for none): an issue-linked recording under it is kept, and its active time says so. */
  floor: number;
  floorText: string;
  focused: boolean;
  scoped: boolean;
  groupById: Map<string, OpsGroup>;
  onOpen: () => void;
  /** The row took the keyboard's focus (Tab, a click): it becomes the list's focused row, the one j/k, Space and Enter act on. */
  onFocus: () => void;
  onPerson: (key: string) => void;
  onEnv: (key: ReplayEnvKey, value: string) => void;
  onHover: (el: HTMLElement) => void;
  onLeave: () => void;
}) {
  const who = personKey(r.user);
  const len = replayLengthText(r);
  const path = replayPagePath(r);
  const active = activeMsOf(r);
  const keptShort = floor > 0 && active !== undefined && active < floor && r.group_ids.length > 0;
  const cut = importedUntil(r.captured_ms, r.duration_ms);
  const press = pressable(onOpen, "link");
  return (
    <div
      className="rp-row"
      data-row
      data-focused={focused ? "true" : undefined}
      data-issues={r.group_ids.length || r.counts.errors > 0 || r.counts.failed_requests > 0 ? undefined : "none"}
      aria-label={`${r.short_id} ${personLabel(r.user)} ${path}`}
      onMouseEnter={(e) => onHover(e.currentTarget)}
      onMouseLeave={onLeave}
      {...press}
      onFocus={(e) => e.target === e.currentTarget && onFocus()}
      // Enter opens the row; Space is the list's preview (its window handler), however the row got focus.
      onKeyDown={(e) => e.key === "Enter" && press.onKeyDown(e)}
    >
      <span role="cell" className="rp-c-mark"><PersonMark label={personLabel(r.user)} personKey={who} anonymous={isAnonymous(r.user)} /></span>
      <span role="cell" className="rp-c-who">
        <span className="rp-who-top">
          {who ? (
            <button type="button" className="rp-person" title={`Only ${personLabel(r.user)}'s recordings${isAnonymous(r.user) && r.user?.id ? ` (id ${r.user.id})` : ""}`} onClick={(e) => { e.stopPropagation(); onPerson(who); }} data-anon={isAnonymous(r.user) ? "true" : undefined}>
              {personLabel(r.user)}
            </button>
          ) : (
            <span className="rp-person ops-dim">Anonymous</span>
          )}
          {!r.has_timeline && r.chunks > 0 && <span className="rp-tag">assembling</span>}
        </span>
        <span className="rp-who-sub" title={r.url ?? undefined}>
          <span className="ops-mono ops-dim">{r.short_id}</span>
          {/* Ids fold to :id as on the replay page and the person card; the raw path stays in the tooltip. */}
          {path ? <PathTail text={routeOf(path)} path /> : <span className="ops-dim" title={r.external_id ? `Recording ${r.external_id}` : undefined}>no page recorded</span>}
          <EnvMarks facts={r.facts} pick={onEnv} />
        </span>
      </span>
      {/* Where the row is two lines, the environment moves to the numbers' line, so the first line names the person and the page whole. */}
      <span role="cell" className="rp-c-env"><EnvMarks facts={r.facts} pick={onEnv} /></span>
      <span role="cell" className="rp-c-strip"><ReplayStrip shape={r.shape} width={80} /></span>
      <span role="cell" className="rp-c-len ops-num" data-known={len.known ? "true" : "false"} title={len.known ? undefined : len.text === "assembling" ? "The recording's chunks are still being read" : len.text === "not imported" ? "Opens on import from its source" : "The recorder did not report a length"}>
        {len.known ? wholeSeconds(len.text) : <span className="ops-dim">{len.text}</span>}
        {len.known && active !== undefined && (keptShort || active < (r.duration_ms ?? 0) * 0.8) && (
          <span className="rp-active ops-dim" data-kept={keptShort ? "true" : undefined} title={keptShort ? `Under the ${floorText} active filter, kept because it caught an issue` : "Active time: the recording less its idle stretches"}>{wholeSeconds(formatReplayTime(active))} active</span>
        )}
        {cut !== null && <CutFact replay={r} cut={cut} now={now} />}
      </span>
      <span role="cell" className="rp-c-figs"><ReplayFigures replay={r} compact /></span>
      <span role="cell" className="rp-c-issue"><IssueChip ids={r.group_ids} groupById={groupById} counts={r.counts} /></span>
      {!scoped && (
        <span role="cell" className="rp-c-src ops-quiet">
          <ProviderIcon provider={r.provider} />
          <span className="truncate">{r.source_name ?? r.provider}</span>
        </span>
      )}
      <span role="cell" className="rp-c-age ops-num ops-quiet" title={new Date(r.started_at).toLocaleString()}>{relTimeShort(r.started_at, now)}</span>
    </div>
  );
}

/** A cut copy's reach and where reading the rest stands, in the replay page's words (restLine). */
function CutFact({ replay: r, cut, now }: { replay: OpsReplay; cut: number; now: number }) {
  const source = useOpsSources().find((s) => s._id === r.source_id);
  const line = restLine(restState(r, now), restHold(r, now), false, r.provider === "posthog" ? "PostHog" : r.provider === "sentry" ? "Sentry" : (r.source_name ?? r.provider), now, restQueued(r, source, now));
  return (
    <span className="rp-active rp-cut-fact" data-state={line.tone} title={`Imported 0:00 to ${formatReplayTime(cut)} of ${formatReplayTime(r.duration_ms ?? 0)} · ${line.text}${line.title ? ` (${line.title})` : ""}`}>
      {wholeSeconds(formatReplayTime(cut))} of {wholeSeconds(formatReplayTime(r.duration_ms ?? 0))}{line.tone === "stopped" ? " · stopped" : ""}
    </span>
  );
}

/** A length as the list reads it: to the second, since tenths do not help pick a recording. */
const wholeSeconds = (text: string) => text.replace(/\.\d$/, "");

/** The issues a recording caught: the first as a chip, the rest counted. One that caught none but failed says what failed; a clean one shows nothing. */
function IssueChip({ ids, groupById, counts }: { ids: string[]; groupById: Map<string, OpsGroup>; counts: OpsReplay["counts"] }) {
  if (ids.length === 0) {
    const parts = [counts.errors > 0 ? plural(counts.errors, "error") : null, counts.failed_requests > 0 ? plural(counts.failed_requests, "failed request") : null].filter(Boolean);
    return parts.length ? <span className="rp-issue ops-quiet" data-unfiled title="Caught here, filed under no issue">{parts.join(" · ")}</span> : null;
  }
  const known = ids.map((id) => groupById.get(id)).filter((g): g is OpsGroup => !!g);
  const first = known[0];
  if (!first) return <span className="rp-issue ops-quiet">{plural(ids.length, "issue")}</span>;
  return (
    <Link
      href={opsHref.issue(first.short_id)}
      className="rp-issue"
      data-status={first.status}
      onClick={(e) => e.stopPropagation()}
      title={known.map((g) => `${g.short_id} ${g.title}`).join("\n")}
    >
      <span className="ops-mono">{first.short_id}</span>
      <PathTail text={first.title} />
      {ids.length > 1 && <span className="ops-dim">+{ids.length - 1}</span>}
    </Link>
  );
}

/**
 * Text cut at its start where the cell is narrow: the end after the last "/"
 * stays, since it is the part that tells one page or issue from the next
 * (an issue title splits only when long, issueTitleParts; a page path always).
 */
function PathTail({ text, path = false }: { text: string; path?: boolean }) {
  const { head, tail } = path ? pagePathParts(text) : issueTitleParts(text);
  return (
    <span className="rp-net-path">
      <span className="rp-net-head">{head}</span>
      {tail && <span className="rp-net-tail">{tail}</span>}
    </span>
  );
}

const PEOPLE_COLS: { sort: ReplayPeopleSort; label: string }[] = [
  { sort: "recordings", label: "Recordings" },
  { sort: "time", label: "Time" },
  { sort: "failures", label: "Failures" },
  { sort: "recent", label: "Last seen" },
];

function PeopleList({ people, total, anonymous, ready, focus, onPick, now, sort, onSort, identified, onIdentified, onMore }: {
  people: ReplayPerson[] | null;
  total: number;
  anonymous: number | null;
  ready: boolean;
  focus: number;
  onPick: (key: string) => void;
  now: number;
  sort: ReplayPeopleSort;
  onSort: (s: ReplayPeopleSort) => void;
  identified: boolean;
  onIdentified: (on: boolean) => void;
  onMore: () => void;
}) {
  if (!ready) return <ListSkeleton bare />;
  const shown = people ?? [];
  return (
    <>
      <div className="rp-people-bar">
        <button type="button" className="rp-toggle" aria-pressed={identified} data-on={identified ? "true" : undefined} onClick={() => onIdentified(!identified)}>
          <UserCheck className="w-3 h-3" aria-hidden /> Identified only
          {anonymous !== null && anonymous > 0 && <span className="ops-dim ops-num">{identified ? `${anonymous.toLocaleString()} hidden` : `${anonymous.toLocaleString()} anonymous`}</span>}
        </button>
      </div>
      {!shown.length ? (
        <div className="rp-none"><b>{identified ? "No identified people in these recordings" : "No known people in these recordings"}</b></div>
      ) : (
        <div className="rp-table" role="table" aria-label="People">
          <div className="rp-prow rp-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">Person</span>
            {PEOPLE_COLS.map((c) => (
              <span key={c.sort} role="columnheader" className="ops-num" aria-sort={sort === c.sort ? "descending" : "none"}>
                <button type="button" className="rp-sort" data-on={sort === c.sort ? "true" : undefined} onClick={() => onSort(c.sort)}>
                  {c.label}
                  {sort === c.sort && <ChevronDown className="w-3 h-3" aria-hidden />}
                </button>
              </span>
            ))}
          </div>
          {shown.map((p, i) => {
            const place = pathOf(p.url);
            return (
              <div key={p.key} className="rp-prow" data-row data-focused={i === focus ? "true" : undefined} aria-label={`${p.anonymous ? `${anonHandle(p.key)}, anonymous` : p.label}, ${plural(p.sessions, "recording")}`} {...pressable(() => onPick(p.key), "button")}>
                <span role="cell"><PersonMark label={p.anonymous ? anonHandle(p.key) : p.label} personKey={p.key} anonymous={p.anonymous} /></span>
                <span role="cell" className="rp-pname">
                  {p.anonymous ? (
                    <>
                      <span className="truncate" data-anon="true">{anonHandle(p.key)}</span>
                      {p.env && <span className="rp-penv ops-quiet truncate">{p.env.replace("Mac OS X", "macOS")}</span>}
                      {place && <span className="rp-pplace truncate ops-dim" title={p.url ?? undefined}>{place}</span>}
                      <button type="button" className="ops-mono ops-dim rp-pid" title={`Copy the id ${p.key}`} aria-label={`Copy the id ${p.key}`} onClick={(e) => { e.stopPropagation(); void copyText(p.key, "Id copied"); }}>
                        {p.key.length > 12 ? `${p.key.slice(0, 8)}…` : p.key}
                        <Copy className="w-2.5 h-2.5" aria-hidden />
                      </button>
                    </>
                  ) : (
                    <span className="truncate">{p.label}</span>
                  )}
                </span>
                <span role="cell" className="ops-num">{p.sessions.toLocaleString()}</span>
                <span role="cell" className="ops-num ops-quiet" title={p.ms ? formatReplayTime(p.ms).replace(/\.\d$/, "") : undefined}>{p.ms ? spanText(p.ms) : <span className="ops-dim">none</span>}</span>
                <span role="cell" className="ops-num">
                  {p.errors > 0 && <span style={{ color: "var(--sol-red)" }}>{plural(p.errors, "error")}</span>}
                  {p.errors > 0 && p.failed > 0 && <span className="ops-dim"> · </span>}
                  {p.failed > 0 && <span style={{ color: "var(--sol-orange)" }} title={plural(p.failed, "failed request")}>{p.failed.toLocaleString()} failed {p.errors > 0 ? "req." : p.failed === 1 ? "request" : "requests"}</span>}
                  {p.errors + p.failed === 0 && <span className="ops-dim">0</span>}
                </span>
                <span role="cell" className="ops-num ops-quiet" title={new Date(p.last_at).toLocaleString()}>{relTimeShort(p.last_at, now)}</span>
              </div>
            );
          })}
        </div>
      )}
      {shown.length > 0 && (
        <div className="rp-more">
          <span className="ops-dim ops-num">{shown.length.toLocaleString()} of {total.toLocaleString()}</span>
          {total > shown.length && (
            <button type="button" className="ops-btn" onClick={onMore}>Show {Math.min(PEOPLE_PAGE, total - shown.length).toLocaleString()} more</button>
          )}
        </div>
      )}
    </>
  );
}

function ListSkeleton({ bare = false }: { bare?: boolean }) {
  const body = (
    <div className="rp-skeleton" aria-label="Reading recordings" role="status">
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="rp-skel-row" style={{ opacity: 1 - i * 0.13 }} />)}
    </div>
  );
  return bare ? body : <div className="ops-pad">{body}</div>;
}

/** The setting that makes a recorder keep a recording with each error (codecast.config.json, contracts/codecastConfig.ts). */
const REPLAY_ON_ERROR_CONFIG = `"replay": { "dom": "onError" }`;

/**
 * A recorder source with no recordings: what it did send (its issues), that
 * none of it carried a recording, and the line of config that turns
 * recording on. It cannot say which: the recorder's mode is not reported.
 */
function RecorderFeeder({ source: s }: { source: OpsSource }) {
  // The same count the Issues tab shows: the open issues themselves once the store holds them, else the server's counter.
  const groups = useOpsGroups();
  const now = useCoarseNow(60_000);
  const issues = useMemo(() => groups.filter((g) => g.source_id === s._id && laneOf(g, now) !== null).length, [groups, s._id, now]) || (s.groups_open ?? 0);
  return (
    <div className="rp-feeder rp-import" data-feeder={s.provider}>
      <span className="rp-import-name"><ProviderIcon provider={s.provider} className="w-3.5 h-3.5" /><span className="truncate">{s.name}</span></span>
      {s.last_event_at ? (
        <span className="rp-import-nums ops-num">
          <span><b>{issues.toLocaleString()}</b> open {issues === 1 ? "issue" : "issues"}</span>
          <span style={{ color: "var(--sol-yellow)" }}><b style={{ color: "inherit" }}>0</b> with a recording</span>
        </span>
      ) : (
        <span className="rp-import-state ops-quiet">No events yet</span>
      )}
      <span className="rp-import-acts">
        <button type="button" className="rp-config ops-mono" title="Copy: add this to codecast.config.json to keep a recording with each error" onClick={() => void copyText(REPLAY_ON_ERROR_CONFIG, "Config line copied")}>
          {REPLAY_ON_ERROR_CONFIG} <Copy className="w-3 h-3" aria-hidden />
        </button>
        <a className="ops-btn" href={SETUP_HREF}>Recorder setup</a>
      </span>
    </div>
  );
}

/** Sources that can hold recordings: a vendor's imported ones, or our recorder's. */
const canRecordReplays = (s: OpsSource) => hasVendorRecordings(s) || s.provider === "sdk" || s.provider === "http";

/** A source that never records, scoped on its own: the workspace's sources that do, each one press away. */
function ReplaysElsewhere({ source, name, sources }: { source: OpsSource | null; name: string; sources: OpsSource[] }) {
  return (
    <div className="ops-pad rp-empty" data-ops-replays-elsewhere>
      <h2 className="rp-empty-title">
        {source && <ProviderIcon provider={source.provider} className="w-4 h-4 inline -mt-0.5 mr-1.5" />}
        {name} <span className="ops-dim">· {source ? SOURCE_PROVIDER_LABEL[source.provider] ?? source.provider : "source"}, no recordings</span>
      </h2>
      <div className="rp-feeders">
        {sources.map((s) => <ElsewhereRow key={s._id} source={s} />)}
      </div>
    </div>
  );
}

/** A source that records, with the count its own list shows (useReplayTotals), one press from it. */
function ElsewhereRow({ source: s }: { source: OpsSource }) {
  const total = useReplayTotal(s.name);
  return (
    <Link href={opsHref.tab("replays", { source: s.name })} className="rp-feeder rp-elsewhere">
      <span className="rp-import-name"><ProviderIcon provider={s.provider} className="w-3.5 h-3.5" /><span className="truncate">{s.name}</span></span>
      <span className="ops-quiet">{SOURCE_PROVIDER_LABEL[s.provider] ?? s.provider}</span>
      {total && total.total > 0 && <span className="ops-num ops-quiet"><b className="ops-num" style={{ color: "var(--sol-text)" }}>{replayTotalText(total)}</b> {total.total === 1 ? "recording" : "recordings"}</span>}
      <span className="rp-elsewhere-go">Open recordings <ArrowRight className="w-3 h-3" aria-hidden /></span>
    </Link>
  );
}

/** What feeds replays, per source, with the one control each needs; with no source, what to connect. */
function ReplaysEmpty({ sources }: { sources: OpsSource[] }) {
  const vendors = sources.filter(hasVendorRecordings);
  const recorders = sources.filter((s) => s.provider === "sdk" || s.provider === "http");
  return (
    <div className="ops-pad rp-empty" data-ops-replays-empty>
      <h2 className="rp-empty-title">No recordings yet</h2>
      {vendors.length + recorders.length > 0 ? (
        <div className="rp-feeders">
          {vendors.map((s) => (
            <div key={s._id} className="rp-feeder">
              <ReplayImportLine source={s} showName />
            </div>
          ))}
          {recorders.map((s) => (
            <RecorderFeeder key={s._id} source={s} />
          ))}
        </div>
      ) : (
        <div className="rp-providers">
          {(["posthog", "sentry", "sdk"] as const).map((p) => (
            <a key={p} href={SETUP_HREF} className="rp-provider"><ProviderIcon provider={p} className="w-4 h-4" />{p === "sdk" ? "Codecast recorder" : SOURCE_PROVIDER_LABEL[p]}</a>
          ))}
        </div>
      )}
      <details className="rp-cli">
        <summary>From the terminal</summary>
        <code className="ops-mono">cast replay import --source &lt;name&gt; --since 30d</code>
      </details>
    </div>
  );
}
