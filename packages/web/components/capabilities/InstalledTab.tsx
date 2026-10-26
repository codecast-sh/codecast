"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Search, X } from "lucide-react";
import { SegmentedToggle } from "../SegmentedToggle";
import { kindMeta, CAPABILITY_KINDS, type CatalogEntry, type CapabilityKind } from "./CapabilityCard";
import { type EquipTarget } from "./EquipControl";
import { CapabilityReader } from "./CapabilityReader";
import type { CapabilityDevice } from "./CapabilityCard";
import { isBroken, type FleetGridRow } from "./FleetMatrix";
import { LoadingMatrix, NoDevices, NoMatches, NothingInstalled, NothingReportedYet } from "./EmptyStates";

/**
 * Installed — what is actually on your machines.
 *
 * The old front door listed only codecast bindings, so a skill sitting in
 * ~/.claude/skills never appeared. This list is the fleet inventory: one row
 * per capability any machine reported, grouped by kind, click to read the file
 * and set where it is on.
 */

export interface InstalledTabProps {
  rows: FleetGridRow[];
  devices: CapabilityDevice[];
  catalog: CatalogEntry[];
  equip: Omit<EquipTarget, "slug">;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  loading?: boolean;
}

function score(row: FleetGridRow, q: string): number {
  const name = row.identity.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if ((row.description ?? "").toLowerCase().includes(q)) return 20;
  return 0;
}

/** Kinds in the order the library presents them; kinds this release does not
 *  model sort last, by name. */
function kindRank(kind: string): number {
  const i = CAPABILITY_KINDS.indexOf(kind as CapabilityKind);
  return i === -1 ? 99 : i;
}

/**
 * The row's machine column, which speaks only when there is something to say:
 * on every machine that reported is the normal case and draws nothing.
 */
function Coverage({ row }: { row: FleetGridRow }) {
  const broken = row.cells.filter(isBroken).length;
  const reporting = row.cells.filter((c) => c.status !== "unknown").length;
  if (broken > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-sol-red" title={`${broken} machine${broken === 1 ? "" : "s"}: switched on, nothing downloaded`}>
        <AlertTriangle className="h-3 w-3" />
        {broken} broken
      </span>
    );
  }
  if (row.activeCount === 0 && row.presentCount > 0) {
    return <span className="text-[11px] text-sol-text-dim">off</span>;
  }
  if (reporting > 1 && row.activeCount < reporting) {
    return (
      <span className="font-mono text-[11px] text-sol-text-muted" title={`On ${row.activeCount} of ${reporting} machines`}>
        {row.activeCount}/{reporting}
      </span>
    );
  }
  return null;
}

export function InstalledTab({ rows, devices, catalog, equip, selectedKey, onSelect, loading }: InstalledTabProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<CapabilityKind | string>("all");
  const catalogBySlug = useMemo(() => new Map(catalog.map((c) => [c.slug, c])), [catalog]);

  const selected = selectedKey ? (rows.find((r) => r.key === selectedKey) ?? null) : null;

  const kindItems = useMemo(() => {
    const tally = new Map<string, number>();
    for (const r of rows) tally.set(String(r.kind), (tally.get(String(r.kind)) ?? 0) + 1);
    const kinds = [...tally.keys()].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
    return [
      { key: "all", label: "All", count: rows.length },
      ...kinds.map((k) => ({ key: k, label: kindMeta(k)?.plural ?? k, count: tally.get(k) })),
    ];
  }, [rows]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (kind !== "all" && String(r.kind) !== kind) return false;
      if (q && score(r, q) === 0) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (q) return score(b, q) - score(a, q) || a.identity.localeCompare(b.identity);
      const ka = String(a.kind);
      const kb = String(b.kind);
      return kindRank(ka) - kindRank(kb) || ka.localeCompare(kb) || a.identity.localeCompare(b.identity);
    });
  }, [rows, kind, q]);

  // Grouped under a kind header when the list is in kind order, so the kind is
  // said once per group rather than on every row. A search ranks by match and
  // mixes kinds, so its results stay one flat list.
  const grouped = !q && kind === "all";

  const renderRow = (row: FleetGridRow) => {
    const meta = kindMeta(String(row.kind));
    const Icon = meta?.icon;
    const active = selectedKey === row.key;
    const description =
      row.description || (row.slug ? catalogBySlug.get(row.slug)?.description : undefined);
    return (
      <li key={row.key}>
        <button
          type="button"
          onClick={() => onSelect(active ? null : row.key)}
          className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
            active ? "bg-sol-magenta/10" : "hover:bg-sol-bg-alt"
          }`}
        >
          {Icon ? (
            <Icon className={`h-4 w-4 shrink-0 ${active ? "text-sol-magenta" : "text-sol-text-dim"}`} strokeWidth={1.5} />
          ) : (
            <span className="h-4 w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className={`truncate font-mono text-[13px] ${active ? "text-sol-magenta" : "text-sol-text"}`}>
              {row.identity}
            </div>
            {description && (
              <div className="truncate text-[11px] text-sol-text-dim">{description}</div>
            )}
          </div>
          <Coverage row={row} />
        </button>
      </li>
    );
  };

  const list = () => {
    if (!grouped) {
      return (
        <ul className="divide-y divide-sol-border/60 overflow-hidden rounded-lg border border-sol-border bg-sol-card">
          {shown.map(renderRow)}
        </ul>
      );
    }
    const groups: Array<[string, FleetGridRow[]]> = [];
    for (const row of shown) {
      const k = String(row.kind);
      const last = groups[groups.length - 1];
      if (last && last[0] === k) last[1].push(row);
      else groups.push([k, [row]]);
    }
    return (
      <div className="overflow-hidden rounded-lg border border-sol-border bg-sol-card">
        {groups.map(([k, group]) => (
          <section key={k}>
            <h3 className="flex items-baseline gap-2 border-b border-sol-border/60 bg-sol-bg-alt px-3 py-1.5 text-[11px] text-sol-text-muted [&:not(:first-child)]:border-t">
              {kindMeta(k)?.plural ?? k}
              <span className="font-mono text-sol-text-dim">{group.length}</span>
            </h3>
            <ul className="divide-y divide-sol-border/60">{group.map(renderRow)}</ul>
          </section>
        ))}
      </div>
    );
  };

  return (
    <div className="cq-container">
    <div className="cap-installed">
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Filter"
              className="h-7 w-full rounded border border-sol-border bg-sol-bg-alt pl-7 pr-7 text-xs text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-magenta/60"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-sol-text-dim hover:text-sol-text"
                aria-label="Clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {kindItems.length > 2 && (
            <SegmentedToggle value={kind} onChange={setKind} items={kindItems} collapse />
          )}
        </div>

        {rows.length === 0 ? (
          loading ? (
            <LoadingMatrix cols={0} />
          ) : devices.length === 0 ? (
            <NoDevices />
          ) : devices.every((d) => d.reportedAt === null) ? (
            <NothingReportedYet deviceCount={devices.length} />
          ) : (
            <NothingInstalled deviceCount={devices.length} />
          )
        ) : shown.length === 0 ? (
          <NoMatches
            query={q || undefined}
            onClear={() => {
              setQuery("");
              setKind("all");
            }}
          />
        ) : (
          list()
        )}
      </div>

      {selected && (
        <div className="cap-installed-reader">
          <CapabilityReader
            row={selected}
            devices={devices}
            onClose={() => onSelect(null)}
            equip={selected.slug ? { slug: selected.slug, ...equip } : undefined}
          />
        </div>
      )}
    </div>
    </div>
  );
}

export { projectChoicesFromSessions } from "./EquipControl";
