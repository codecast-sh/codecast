// The masthead (spec 4.1): the page name, the repository when the team works
// in more than one, the day with a strip of the week's seven days inked by
// commit volume, Day | Week, the double rule, the day's counts, the branch
// toggle and the filters. Every control writes the URL.
import { ChevronDown, ChevronLeft, ChevronRight, ListFilter, X } from "lucide-react";
import { useState, type RefObject } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { DottedRow } from "../entityDisplay";
import { SegmentedToggle } from "../SegmentedToggle";
import { Pill } from "../feed/ExternalEventRow";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { areaFill, areaLabel, ink } from "./areaColor";
import type { EditionStats } from "./editionModel";
import { plural } from "./format";
import { AreaDot, Tip, clockOf } from "./StoryParts";
import { useAreaColors } from "./storyContext";
import { KeyHint } from "./useChangesKeys";
import { hasFilters, toggleArea, type ChangesUrl, type SetChangesUrl } from "./useChangesUrlState";

const WEEKDAY_INITIAL = ["S", "M", "T", "W", "T", "F", "S"];

const dayNumber = (ymd: string) => Number(ymd.slice(8, 10));
const weekdayOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export type Summarizing = { since: number | null; stale: boolean } | null;

export type FilterOptions = {
  areas: string[];
  people: { id: string; name: string }[];
};

function RepoPicker({ repos, repo, onPick }: { repos: { repo: string; commits: number }[]; repo: string | undefined; onPick: (repo: string) => void }) {
  if (repos.length < 2 || !repo) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-full" aria-label="Repository">
        <Pill>
          <span className="truncate font-mono">{repo}</span>
          <ChevronDown className="h-2.5 w-2.5 shrink-0" />
        </Pill>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        {repos.map((r) => (
          <DropdownMenuItem key={r.repo} onSelect={() => onPick(r.repo)} className="flex items-center justify-between gap-4 font-mono text-[11px]">
            <span className={r.repo === repo ? "text-sol-text" : "text-sol-text/70"}>{r.repo}</span>
            <span className="tabular-nums text-sol-text/45">{r.commits}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DayStrip({ days, date, today, volumes, onDay }: {
  days: readonly string[];
  date: string;
  today: string;
  volumes: Record<string, number | null>;
  onDay: (day: string) => void;
}) {
  const max = Math.max(1, ...days.map((d) => volumes[d] ?? 0));
  return (
    <div className="flex items-end gap-1" role="group" aria-label="Days of the week">
      {days.map((d) => {
        const v = volumes[d];
        const future = d > today;
        const selected = d === date;
        const label = `${changesDayLabel(d)}${v != null ? `, ${plural(v, "commit")}` : ""}`;
        return (
          <Tip key={d} text={label} side="bottom">
            <button
              type="button"
              disabled={future}
              onClick={() => onDay(d)}
              aria-current={selected ? "date" : undefined}
              aria-label={label}
              className={`flex w-8 flex-col items-center rounded-[4px] pb-1 pt-0.5 font-mono transition-colors disabled:cursor-default disabled:opacity-30 ${
                selected ? "bg-sol-bg-alt text-sol-text" : "text-sol-text/55 hover:bg-sol-bg-alt/60 hover:text-sol-text"
              }`}
            >
              <span className="text-[10px] leading-none" style={{ color: ink(45) }}>{WEEKDAY_INITIAL[weekdayOf(d)]}</span>
              <span className={`mt-0.5 text-[12px] leading-none tabular-nums ${selected ? "font-semibold" : ""}`}>{dayNumber(d)}</span>
              <span
                aria-hidden
                className="mt-1 h-[2px] w-5 rounded-full"
                style={{ background: v == null || future ? ink(6) : ink(15 + (55 * v) / max) }}
              />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** Two or three settings of one view, as the app's segmented toggle: a group of pressed buttons, no tab panels. */
function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="font-mono">
      <SegmentedToggle
        size="sm"
        value={value}
        onChange={(v) => onChange(v as T)}
        items={options.map((o) => ({ key: o.value, label: o.label, title: o.hint }))}
      />
    </div>
  );
}

function Chip({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 font-mono text-[11px] transition-colors ${
        active ? "border-sol-border/70 text-sol-text" : "border-sol-border/25 text-sol-text/60 hover:border-sol-border/50 hover:text-sol-text"
      }`}
      style={active && color ? { background: color } : undefined}
    >
      {children}
    </button>
  );
}

function FilterBar({ url, setUrl, options, inputRef, personName, hasSignals }: {
  url: ChangesUrl;
  setUrl: SetChangesUrl;
  options: FilterOptions;
  inputRef: RefObject<HTMLInputElement | null>;
  personName: (id: string) => string;
  /** Any ship is known, so a story can wait behind one. */
  hasSignals: boolean;
}) {
  // The field holds what is typed; the URL holds it trimmed. A change from
  // outside (Escape, clear filters, a pasted link) resets the field.
  const [q, setQ] = useState(url.q ?? "");
  useWatchEffect(() => {
    setQ((typed) => ((url.q ?? "") !== typed.trim() ? url.q ?? "" : typed));
  }, [url.q]);
  const colors = useAreaColors();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <input
        ref={inputRef}
        value={q}
        placeholder="Filter stories"
        aria-label="Filter stories"
        onChange={(e) => {
          setQ(e.target.value);
          setUrl({ q: e.target.value.trim() || undefined });
        }}
        className="h-[22px] w-44 rounded-full border border-sol-border/30 bg-transparent px-2.5 font-mono text-[11px] text-sol-text outline-none placeholder:text-sol-text/40 focus:border-sol-border/70"
      />
      {options.areas.map((a) => (
        <Chip key={a} active={url.areas.includes(a)} onClick={() => setUrl((s) => toggleArea(s, a))} color={areaFill(a, 14, colors)}>
          <AreaDot area={a} />
          {areaLabel(a)}
        </Chip>
      ))}
      {options.people.map((p) => (
        <Chip key={p.id} active={url.person === p.id} onClick={() => setUrl({ person: url.person === p.id ? undefined : p.id })}>
          {p.name}
        </Chip>
      ))}
      {url.person && !options.people.some((p) => p.id === url.person) && (
        <Chip active onClick={() => setUrl({ person: undefined })}>{personName(url.person)}</Chip>
      )}
      <Chip active={url.risk} onClick={() => setUrl((s) => ({ ...s, risk: !s.risk }))}>risks</Chip>
      {(hasSignals || url.waiting) && <Chip active={url.waiting} onClick={() => setUrl((s) => ({ ...s, waiting: !s.waiting }))}>waiting</Chip>}
      {url.surface && (
        <Chip active onClick={() => setUrl({ surface: undefined })} color={areaFill(url.surface, 14, colors)}>
          {url.surface} surface <X className="h-2.5 w-2.5" />
        </Chip>
      )}
    </div>
  );
}

export function ChangesHeader(props: {
  repos: { repo: string; commits: number }[];
  repo: string | undefined;
  date: string;
  today: string;
  weekDays: readonly string[];
  volumes: Record<string, number | null>;
  /** The view's counts; null while the view is still loading, when a count would be a guess, and for a quiet day, whose head already says nothing landed. */
  stats: EditionStats | null;
  /** The view is still loading: a null `stats` holds the counts' line open with a bar. */
  loading?: boolean;
  summarizing: Summarizing;
  url: ChangesUrl;
  setUrl: SetChangesUrl;
  mode: "day" | "week";
  onDay: (day: string) => void;
  /** Today in the mode on screen: the day, or this week. */
  onToday: () => void;
  onStep: (delta: number) => void;
  onMode: (mode: "day" | "week") => void;
  filterOpen: boolean;
  onToggleFilter: () => void;
  filterRef: RefObject<HTMLInputElement | null>;
  /** The filter toggle, where focus returns when the filter field is left. */
  filterToggleRef?: RefObject<HTMLButtonElement | null>;
  options: FilterOptions;
  personName: (id: string) => string;
  /** Any ship is known, so the waiting filter has something to show. */
  hasSignals: boolean;
  /** Stories on screen that carry a risk; the count toggles the risk filter. */
  risks: number;
}) {
  const { url, setUrl, date, today, stats } = props;
  const since = props.summarizing?.since;
  const sinceText = since == null ? "" : localDay(0, since) === today ? clockOf(since) : `${changesDayLabel(localDay(0, since))}, ${clockOf(since)}`;
  const label = props.mode === "week" ? `Week of ${changesDayLabel(props.weekDays[0])}` : changesDayLabel(date);
  const atToday = props.mode === "week" ? props.weekDays.includes(today) : date >= today;
  const filtering = hasFilters(url);
  const parts = !stats ? null : [
    { key: "commits", node: plural(stats.commits, "commit") },
    { key: "stories", node: plural(stats.stories, "story", "stories") },
    ...(stats.releases ? [{ key: "releases", node: plural(stats.releases, "release") }] : []),
    { key: "people", node: plural(stats.people, "person", "people") },
    ...(stats.sessions ? [{ key: "sessions", node: plural(stats.sessions, "session") }] : []),
    ...(props.risks || url.risk ? [{
      key: "risks",
      node: (
        <button
          type="button"
          onClick={() => setUrl((s) => ({ ...s, risk: !s.risk }))}
          aria-pressed={url.risk}
          className={`rounded-sm underline-offset-2 transition-colors hover:text-sol-text hover:underline ${url.risk ? "text-sol-text" : ""}`}
        >
          {plural(props.risks, "risk")}
        </button>
      ),
    }] : []),
    // The edition's notes are being written, or wait to be: said in words, where the counts are.
    ...(props.summarizing ? [{
      key: "notes",
      node: <span style={{ color: ink(45) }}>{props.summarizing.stale && sinceText ? `notes queued since ${sinceText}` : "notes updating"}</span>,
    }] : []),
  ];
  return (
    <header className="pt-6" data-changes-header>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="chg-ui text-[20px] font-semibold text-sol-text">Changes</h1>
        <RepoPicker repos={props.repos} repo={props.repo} onPick={(repo) => setUrl({ repo, story: undefined }, "push")} />
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => props.onStep(-1)} className="rounded p-1 text-sol-text/55 hover:bg-sol-bg-alt hover:text-sol-text" aria-label={props.mode === "week" ? "Previous week" : "Previous day"}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          {/* Where the keyboard lands after a day or week travel takes its story away; the new view is announced. */}
          <span data-changes-date tabIndex={-1} aria-live="polite" className="chg-ui min-w-[6.5rem] text-left text-[15px] font-semibold tabular-nums text-sol-text outline-none">{label}</span>
          <button type="button" onClick={() => props.onStep(1)} disabled={atToday} className="rounded p-1 text-sol-text/55 hover:bg-sol-bg-alt hover:text-sol-text disabled:opacity-30 disabled:hover:bg-transparent" aria-label={props.mode === "week" ? "Next week" : "Next day"}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          {!atToday && (
            <button type="button" onClick={props.onToday} className="ml-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-sol-text/55 hover:bg-sol-bg-alt hover:text-sol-text">
              today
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <DayStrip days={props.weekDays} date={date} today={today} volumes={props.volumes} onDay={props.onDay} />
          <Segmented
            label="Day or week"
            value={props.mode}
            onChange={props.onMode}
            options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]}
          />
        </div>
      </div>
      <div className="chg-rule mt-3" />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {parts ? (
          <DottedRow parts={parts} className="font-mono !text-[11px] tabular-nums !text-sol-text/55" />
        ) : props.loading ? (
          // The counts' line, held open by a bar, so nothing shifts when they arrive.
          <span aria-hidden className="inline-flex items-center font-mono text-[11px]">
            <span className="inline-block h-[0.7em] w-44 rounded bg-sol-bg-alt/70" />&nbsp;
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            label="Branches"
            value={url.branches}
            onChange={(branches) => setUrl({ branches })}
            options={[{ value: "main", label: "main", hint: "Default branch" }, { value: "all", label: "all branches" }]}
          />
          <button
            ref={props.filterToggleRef}
            type="button"
            onClick={props.onToggleFilter}
            aria-expanded={props.filterOpen}
            className={`inline-flex h-[24px] items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] transition-colors ${
              props.filterOpen || filtering ? "border-sol-border/60 text-sol-text" : "border-sol-border/30 text-sol-text/55 hover:text-sol-text"
            }`}
          >
            <ListFilter className="h-3 w-3" />
            filter
            <KeyHint action="changes.filter" />
          </button>
        </div>
      </div>
      {(props.filterOpen || filtering) && (
        <FilterBar url={url} setUrl={setUrl} options={props.options} inputRef={props.filterRef} personName={props.personName} hasSignals={props.hasSignals} />
      )}
    </header>
  );
}
