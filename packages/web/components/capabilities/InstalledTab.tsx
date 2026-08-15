"use client";

import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { CapabilityBindingRow } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { kindMeta, type CatalogEntry } from "./CapabilityCard";
import { EquipControl, equipScopeOf, projectChoicesFromSessions, type EquipTarget } from "./EquipControl";

/**
 * Installed — the simple surface.
 *
 * One row per capability the user has said something about, the equip control
 * on every row, and a search that adds from the catalog into a scope with one
 * click. This is the tab a person lives in; the fleet matrix, drift marks and
 * audit trail are still there under Machines for when something is wrong, but
 * they are not the front door.
 *
 * Reads bindings from the store (localFirst: a toggle renders before the
 * round trip) and the catalog the page already loaded — no queries of its own.
 */

export interface InstalledTabProps {
  catalog: CatalogEntry[];
  /** Repos + current session for the equip control's choices. */
  equip: Omit<EquipTarget, "slug">;
  /** Names a machine has actually reported having this slug on. Not required
   *  for the tab to work — it renders "not on any machine yet" honestly. */
  installedOn?: (slug: string) => string[];
}

function scopeSummary(rows: CapabilityBindingRow[]): string {
  const on = rows.filter((r) => r.enabled);
  if (on.length === 0) return "off";
  const kinds = new Set(on.map((r) => equipScopeOf(r)));
  if (kinds.has("everywhere")) return kinds.size === 1 ? "everywhere" : "everywhere + narrower";
  if (kinds.has("project")) return on.filter((r) => r.scope_kind === "project").length === 1 ? "one project" : `${on.filter((r) => r.scope_kind === "project").length} projects`;
  return "this session";
}

export function InstalledTab({ catalog, equip, installedOn }: InstalledTabProps) {
  const bindings = useInboxStore((s) => s.capabilityBindings);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const bySlug = useMemo(() => {
    const m = new Map<string, CapabilityBindingRow[]>();
    for (const b of Object.values(bindings)) {
      const list = m.get(b.capability_slug) ?? [];
      list.push(b);
      m.set(b.capability_slug, list);
    }
    return m;
  }, [bindings]);

  const catalogBySlug = useMemo(() => new Map(catalog.map((c) => [c.slug, c])), [catalog]);

  const rows = useMemo(
    () =>
      [...bySlug.entries()]
        .map(([slug, rowsFor]) => ({ slug, rows: rowsFor, entry: catalogBySlug.get(slug) }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    [bySlug, catalogBySlug],
  );

  const q = query.trim().toLowerCase();
  const addable = useMemo(() => {
    if (!q) return [];
    return catalog
      .filter((c) => !bySlug.has(c.slug))
      .filter((c) => `${c.name} ${c.slug} ${c.description ?? ""}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [catalog, bySlug, q]);

  return (
    <div className="flex flex-col gap-4">
      {/* Add bar: search the catalog, equip into a scope in one gesture. */}
      <div className="relative">
        <div className="flex items-center gap-2 rounded-lg border border-sol-border bg-sol-card px-3 py-2">
          <Search className="h-4 w-4 text-sol-text-dim" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAdding(true);
            }}
            onFocus={() => setAdding(true)}
            placeholder="Add a skill, plugin, or MCP server…"
            className="flex-1 bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setAdding(false);
              }}
              className="text-sol-text-dim hover:text-sol-text"
              aria-label="Clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="hidden items-center gap-1 text-[10px] text-sol-text-dim sm:flex">
            <KeyCap>/</KeyCap> to focus
          </span>
        </div>
        {adding && q && (
          <div className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-lg border border-sol-border bg-sol-card shadow-lg">
            {addable.length === 0 ? (
              <div className="px-3 py-3 text-xs text-sol-text-muted">
                Nothing in the catalog matches — try the Library tab for public sources.
              </div>
            ) : (
              addable.map((c) => {
                const meta = kindMeta(c.kind);
                return (
                  <div
                    key={c.slug}
                    className="flex items-center gap-3 border-b border-sol-border/60 px-3 py-2 last:border-b-0"
                  >
                    {meta && <meta.icon className="h-4 w-4 shrink-0 text-sol-text-muted" strokeWidth={1.5} />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-sol-text">{c.name}</div>
                      {c.description && (
                        <div className="truncate text-[11px] text-sol-text-dim">{c.description}</div>
                      )}
                    </div>
                    <EquipControl target={{ slug: c.slug, ...equip }} />
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-sol-border px-4 py-8 text-center">
          <Plus className="mx-auto mb-2 h-5 w-5 text-sol-text-dim" strokeWidth={1.5} />
          <div className="text-sm text-sol-text">Nothing turned on yet</div>
          <div className="mt-1 text-xs text-sol-text-muted">
            Search above to add something, and choose where it applies — everywhere, one project, or just
            this session.
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-sol-border/60 overflow-hidden rounded-lg border border-sol-border bg-sol-card">
          {rows.map(({ slug, rows: rowsFor, entry }) => {
            const meta = entry ? kindMeta(entry.kind) : undefined;
            const on = installedOn?.(slug) ?? [];
            return (
              <li key={slug} className="flex items-center gap-3 px-3 py-2.5">
                {meta ? (
                  <meta.icon className="h-4 w-4 shrink-0 text-sol-text-muted" strokeWidth={1.5} />
                ) : (
                  <span className="h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm text-sol-text">{entry?.name ?? slug}</span>
                    <span className="text-[10px] text-sol-text-dim">{scopeSummary(rowsFor)}</span>
                  </div>
                  <div className="truncate text-[11px] text-sol-text-dim">
                    {on.length > 0
                      ? `on ${on.length} machine${on.length === 1 ? "" : "s"}`
                      : "not on any machine yet — the daemon materializes it on its next pass"}
                  </div>
                </div>
                <EquipControl target={{ slug, ...equip }} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export { projectChoicesFromSessions };
