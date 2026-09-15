"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { SegmentedToggle } from "../SegmentedToggle";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { kindMeta, CAPABILITY_KINDS, KIND_META, type CatalogEntry, type CapabilityKind } from "./CapabilityCard";
import { type EquipTarget } from "./EquipControl";
import { CapabilityReader } from "./CapabilityReader";
import type { CapabilityDevice } from "./CapabilityCard";
import type { FleetGridRow } from "./FleetMatrix";

/**
 * Installed — what is actually on your machines.
 *
 * The old front door listed only codecast bindings, so a skill sitting in
 * ~/.claude/skills never appeared. This list is the fleet inventory: one row
 * per capability any machine reported, click to read the file.
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

export function InstalledTab({ rows, devices, catalog, equip, selectedKey, onSelect, loading }: InstalledTabProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<CapabilityKind | string>("all");
  const catalogBySlug = useMemo(() => new Map(catalog.map((c) => [c.slug, c])), [catalog]);

  const selected = selectedKey ? (rows.find((r) => r.key === selectedKey) ?? null) : null;

  const kindItems = useMemo(() => {
    const present = new Set(rows.map((r) => String(r.kind)));
    const items = [{ key: "all", label: "All" }];
    for (const k of CAPABILITY_KINDS) {
      if (!present.has(k)) continue;
      items.push({ key: k, label: KIND_META[k].plural });
    }
    for (const k of [...present].sort()) {
      if ((CAPABILITY_KINDS as readonly string[]).includes(k)) continue;
      items.push({ key: k, label: k });
    }
    return items;
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (kind !== "all" && String(r.kind) !== kind) return false;
      if (q && score(r, q) === 0) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (q) return score(b, q) - score(a, q) || a.identity.localeCompare(b.identity);
      const ka = String(a.kind);
      const kb = String(b.kind);
      const ia = CAPABILITY_KINDS.indexOf(ka as CapabilityKind);
      const ib = CAPABILITY_KINDS.indexOf(kb as CapabilityKind);
      const ra = ia === -1 ? 99 : ia;
      const rb = ib === -1 ? 99 : ib;
      return ra - rb || a.identity.localeCompare(b.identity);
    });
  }, [rows, kind, query]);

  return (
    <div className="cq-container">
    <div className="cap-installed">
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-sol-border bg-sol-card px-3 py-2">
          <Search className="h-4 w-4 text-sol-text-dim" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter skills, commands, plugins…"
            className="flex-1 bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-sol-text-dim hover:text-sol-text"
              aria-label="Clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="hidden items-center gap-1 text-[10px] text-sol-text-dim sm:flex">
            <KeyCap size="xs">Esc</KeyCap>
            clears
          </span>
        </div>

        {kindItems.length > 2 && (
          <SegmentedToggle value={kind} onChange={setKind} items={kindItems} />
        )}

        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-sol-border px-4 py-8 text-center">
            <div className="text-sm text-sol-text">
              {loading ? "Reading machines…" : "Nothing reported yet"}
            </div>
            <div className="mt-1 text-xs text-sol-text-muted">
              {loading
                ? "Waiting on the first inventory from a daemon."
                : "The daemon scans the skills on this machine and sends them up. A new file usually shows within a minute. The Library tab is for adding something you do not have."}
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-sol-border px-4 py-8 text-center text-sm text-sol-text-muted">
            Nothing matches{query ? ` “${query}”` : ""}.
          </div>
        ) : (
          <ul className="divide-y divide-sol-border/60 overflow-hidden rounded-lg border border-sol-border bg-sol-card">
            {shown.map((row) => {
              const meta = kindMeta(String(row.kind));
              const Icon = meta?.icon;
              const active = selectedKey === row.key;
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => onSelect(active ? null : row.key)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-sol-magenta/10" : "hover:bg-sol-bg-alt"
                    }`}
                  >
                    {Icon ? (
                      <Icon className="h-4 w-4 shrink-0 text-sol-text-muted" strokeWidth={1.5} />
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm text-sol-text">{row.identity}</span>
                        <span className="text-[10px] text-sol-text-dim">{meta?.label ?? String(row.kind)}</span>
                      </div>
                      <div className="truncate text-[11px] text-sol-text-dim">
                        {row.description ||
                          (row.slug ? catalogBySlug.get(row.slug)?.description : undefined) ||
                          (row.activeCount > 0
                            ? `on ${row.activeCount} machine${row.activeCount === 1 ? "" : "s"}`
                            : "present")}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
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
