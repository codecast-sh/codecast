"use client";
// /pages — gallery of the published pages in the active workspace
// (cast publish). Data: store.artifacts, fed by artifacts.listForWeb (hooks/useSyncArtifacts).

import { useMemo, useState } from "react";
import { useArtifacts } from "../../hooks/useSyncArtifacts";
import { useInboxStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import { ArrowUpDown, CalendarDays, Globe, LayoutGrid, Search, User, X } from "lucide-react";
import { ArtifactCard, type ArtifactRow } from "./ArtifactCard";
import { FilterDropdown, type FilterOption } from "../FilterDropdown";
import { SegmentedToggle } from "../SegmentedToggle";
import { groupByDay, pageTime, sortPages, type PageSort } from "./artifactCardUtils";
import { ArtifactEditModal } from "./ArtifactEditModal";
import { FeatureUpsell } from "../agentFeatures/FeatureUpsell";

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center py-24 px-8">
      <Globe className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">No published pages yet</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Any page an agent publishes gets a stable link you can share. Publishing
        it again updates the same link and keeps every version.
      </div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Ask an agent to publish a report, a mockup or a chart, and it shows up here.
      </div>
      <div className="text-xs text-sol-text-dim max-w-md">
        Viewer comments arrive back in the publishing session as messages.
      </div>
    </div>
  );
}

const SORTS: FilterOption[] = [
  { key: "updated", label: "Last updated" },
  { key: "published", label: "First published" },
  { key: "views", label: "Most viewed" },
  { key: "title", label: "Title" },
];

const VIEWS = [
  { key: "grid", icon: LayoutGrid, title: "Grid" },
  { key: "timeline", icon: CalendarDays, title: "Timeline" },
];

/** One option per person who published a page here, you first, then by count. */
function personOptions(rows: ArtifactRow[]): FilterOption[] {
  const people = new Map<string, { a: ArtifactRow; count: number }>();
  for (const a of rows) {
    const key = a.author_id ?? (a.mine ? "me" : "");
    if (!key) continue;
    const p = people.get(key) ?? { a, count: 0 };
    p.count++;
    people.set(key, p);
  }
  return [...people.entries()]
    .sort(([, x], [, y]) => Number(y.a.mine) - Number(x.a.mine) || y.count - x.count)
    .map(([key, { a, count }]) => ({
      key,
      label: a.mine ? "You" : a.author?.name ?? "Teammate",
      count,
      face: a.author?.image
        ? <AvatarImg src={a.author.image} alt="" className="w-3.5 h-3.5 rounded-full flex-shrink-0" />
        : <User className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />,
    }));
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-sol-border/30 overflow-hidden animate-pulse"
        >
          <div className="aspect-[1.91/1] bg-sol-bg-alt/60" />
          <div className="p-3 space-y-2">
            <div className="h-3.5 w-2/3 rounded bg-sol-bg-alt/60" />
            <div className="h-3 w-1/2 rounded bg-sol-bg-alt/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ArtifactGallery() {
  // Store-fed (hooks/useSyncArtifacts): the gallery paints from the cached
  // set; the skeleton shows only for a genuinely cold cache.
  const { artifacts: rows, ready } = useArtifacts();
  const artifacts = rows as ArtifactRow[];
  const data = ready || artifacts.length > 0 ? { artifacts } : undefined;
  const view = useInboxStore((s) => s.clientState?.ui?.pages_view ?? "grid");
  const sort = useInboxStore((s) => s.clientState?.ui?.pages_sort ?? "updated") as PageSort;
  const setUI = (ui: { pages_view?: "grid" | "timeline"; pages_sort?: PageSort }) =>
    useInboxStore.getState().updateClientUI(ui);
  const [people, setPeople] = useState("");
  const [query, setQuery] = useState("");
  const [teamEditing, setTeamEditing] = useState<ArtifactRow | null>(null);

  const personOpts = useMemo(() => personOptions(artifacts), [artifacts]);
  const shown = useMemo(() => {
    const picked = new Set(people ? people.split(",") : []);
    const q = query.trim().toLowerCase();
    const kept = artifacts.filter(
      (a) =>
        (!picked.size || picked.has(a.author_id ?? (a.mine ? "me" : ""))) &&
        (!q || (a.title || a.slug).toLowerCase().includes(q)),
    );
    return sortPages(kept, sort);
  }, [artifacts, people, query, sort]);
  const days = useMemo(() => (view === "timeline" ? groupByDay(shown, sort) : []), [view, shown, sort]);
  const filtered = !!people || !!query.trim();

  return (
    <div className="py-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-5">
        <h1 className="text-lg font-semibold text-sol-text">Pages</h1>
        {data && artifacts.length > 0 && (
          <span className="text-xs text-sol-text-dim font-mono tabular-nums">
            {filtered ? `${shown.length} / ${artifacts.length}` : artifacts.length}
          </span>
        )}
        {data && artifacts.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-sol-border/40 focus-within:border-sol-cyan/50">
              <Search className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
                placeholder="Title"
                className="w-28 bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim outline-none"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear" className="text-sol-text-dim hover:text-sol-text">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {personOpts.length > 1 && (
              <FilterDropdown
                label="Anyone"
                icon={<User className="w-3.5 h-3.5" />}
                value={people}
                options={[{ key: "", label: "Anyone" }, ...personOpts]}
                onChange={setPeople}
                multi
              />
            )}
            <FilterDropdown
              label="Sort"
              icon={<ArrowUpDown className="w-3.5 h-3.5" />}
              value={sort}
              options={SORTS}
              onChange={(v) => setUI({ pages_sort: (v || "updated") as PageSort })}
            />
            <SegmentedToggle
              value={view}
              onChange={(v) => setUI({ pages_view: v as "grid" | "timeline" })}
              items={VIEWS}
            />
          </div>
        )}
      </div>

      <FeatureUpsell
        slug="publish"
        className="mb-5"
        reason="Agents can publish their reports, dashboards and mockups here, each at a link you can share."
      />

      {data === undefined ? (
        <SkeletonGrid />
      ) : artifacts.length === 0 ? (
        <EmptyState />
      ) : shown.length === 0 ? (
        <div className="py-16 text-center text-sm text-sol-text-dim">No pages match</div>
      ) : view === "timeline" ? (
        <div className="flex flex-col gap-5">
          {days.map((d) => (
            <section key={d.key}>
              <div className="flex items-baseline gap-2 px-2 pb-1 mb-1 border-b border-sol-border/30">
                <h2 className="text-xs font-semibold text-sol-text-muted">{d.label}</h2>
                <span className="text-[11px] text-sol-text-dim font-mono tabular-nums">{d.rows.length}</span>
              </div>
              {d.rows.map((a) => (
                <ArtifactCard
                  key={a.slug}
                  artifact={a}
                  layout="row"
                  time={pageTime(a, sort === "published" ? "published" : "updated")}
                  onTeamEdit={a.mine ? undefined : setTeamEditing}
                />
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {shown.map((a) => (
            <ArtifactCard key={a.slug} artifact={a} onTeamEdit={a.mine ? undefined : setTeamEditing} />
          ))}
        </div>
      )}

      {teamEditing && <ArtifactEditModal artifact={teamEditing} onClose={() => setTeamEditing(null)} />}
    </div>
  );
}
