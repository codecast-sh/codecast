// The timeline's masthead: the page name, the repository when the team works
// in more than one, what is live right now in one quiet line, and two
// controls that open what the page tucks away: the filters, and the work
// still in progress. Every filter writes the URL.
import { ChevronDown, ListFilter } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";
import type { LiveRow, WorksRow } from "../../hooks/useSyncChanges";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatDateSmart } from "../../lib/utils";
import { Pill } from "../feed/ExternalEventRow";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { areaFill, areaLabel } from "./areaColor";
import { plural } from "./format";
import { InTheWorks } from "./InTheWorks";
import { AreaDot, Tip } from "./StoryParts";
import { useAreaColors } from "./storyContext";
import { KeyHint } from "./useChangesKeys";
import { hasFilters, toggleArea, type ChangesUrl, type SetChangesUrl, type Zoom } from "./useChangesUrlState";

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

function FilterBar({ url, setUrl, options, inputRef, personName }: {
  url: ChangesUrl;
  setUrl: SetChangesUrl;
  options: FilterOptions;
  inputRef: RefObject<HTMLInputElement | null>;
  personName: (id: string) => string;
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
      <Chip active={url.branches === "all"} onClick={() => setUrl((s) => ({ ...s, branches: s.branches === "all" ? "main" : "all" }))}>all branches</Chip>
    </div>
  );
}


/** What is live, one surface per item: its version (or short sha for a deploy), and how many stories wait behind it. */
function LiveLine({ live }: { live: readonly LiveRow[] }) {
  if (!live.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-sol-text/50">
      <span className="text-sol-text/40">live</span>
      {live.map((l) => {
        const label = l.version ?? l.sha.slice(0, 7);
        const tip = `${l.surface} ${label}, ${l.kind === "deploy" ? "deployed" : "shipped"} ${formatDateSmart(l.at)}${l.waiting ? `. ${plural(l.waiting, "story", "stories")} landed since.` : ""}`;
        return (
          <Tip key={l.surface} text={tip}>
            <span className="tabular-nums">
              {l.surface} <span className="text-sol-text/75">{label}</span>
              {l.waiting > 0 && <span className="text-sol-text/40"> +{l.waiting}</span>}
            </span>
          </Tip>
        );
      })}
    </span>
  );
}

function Toggle({ open, onClick, children, buttonRef }: { open: boolean; onClick: () => void; children: ReactNode; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={`inline-flex h-[24px] items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] transition-colors ${
        open ? "border-sol-border/60 text-sol-text" : "border-sol-border/30 text-sol-text/55 hover:text-sol-text"
      }`}
    >
      {children}
    </button>
  );
}

/** How far out the timeline reads: by age (the default), or one level everywhere. */
function ZoomControl({ zoom, onZoom }: { zoom: Zoom | undefined; onZoom: (z: Zoom | undefined) => void }) {
  const levels: Array<[Zoom | undefined, string, string]> = [
    [undefined, "auto", "Recent days in full, older ones further out"],
    ["changes", "changes", "Every change, day by day"],
    ["days", "days", "Each day told whole"],
    ["weeks", "weeks", "Each week told whole"],
  ];
  return (
    <div role="radiogroup" aria-label="Zoom" className="inline-flex h-[24px] items-center rounded-md border border-sol-border/30 p-px">
      {levels.map(([z, label, tip]) => (
        <Tip key={label} text={tip}>
          <button
            type="button"
            role="radio"
            aria-checked={zoom === z}
            onClick={() => onZoom(z)}
            className={`h-full rounded-[5px] px-2 font-mono text-[11px] transition-colors ${zoom === z ? "bg-sol-bg-alt text-sol-text" : "text-sol-text/50 hover:text-sol-text"}`}
          >
            {label}
          </button>
        </Tip>
      ))}
    </div>
  );
}

export function TimelineHeader(props: {
  repos: { repo: string; commits: number }[];
  repo: string | undefined;
  url: ChangesUrl;
  setUrl: SetChangesUrl;
  live: readonly LiveRow[];
  works: readonly WorksRow[];
  filterOpen: boolean;
  onToggleFilter: () => void;
  filterRef: RefObject<HTMLInputElement | null>;
  filterToggleRef?: RefObject<HTMLButtonElement | null>;
  options: FilterOptions;
  personName: (id: string) => string;
}) {
  const { url, setUrl } = props;
  const [worksOpen, setWorksOpen] = useState(false);
  const filtering = hasFilters(url);
  const moving = props.works.filter((w) => w.kind !== "branch").length;
  return (
    <header className="pt-6" data-changes-header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="chg-ui text-[20px] font-semibold text-sol-text">Changes</h1>
        <RepoPicker repos={props.repos} repo={props.repo} onPick={(repo) => setUrl({ repo, story: undefined }, "push")} />
        <div className="ml-auto flex items-center gap-2">
          <ZoomControl zoom={url.zoom} onZoom={(zoom) => setUrl({ zoom })} />
          {moving > 0 && (
            <Toggle open={worksOpen} onClick={() => setWorksOpen((o) => !o)}>
              in progress <span className="tabular-nums text-sol-text/45">{moving}</span>
            </Toggle>
          )}
          <Toggle open={props.filterOpen || filtering} onClick={props.onToggleFilter} buttonRef={props.filterToggleRef}>
            <ListFilter className="h-3 w-3" />
            filter
            <KeyHint action="changes.filter" />
          </Toggle>
        </div>
      </div>
      <div className="mt-1.5"><LiveLine live={props.live} /></div>
      {(props.filterOpen || filtering) && (
        <FilterBar url={url} setUrl={setUrl} options={props.options} inputRef={props.filterRef} personName={props.personName} />
      )}
      {worksOpen && (
        <div className="mt-4 rounded-lg border border-sol-border/25 bg-sol-card/50 p-4">
          <InTheWorks works={props.works} areas={[]} areasLabel="" live viewed="" />
        </div>
      )}
    </header>
  );
}
