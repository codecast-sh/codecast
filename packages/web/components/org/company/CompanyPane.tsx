"use client";
// The Org screen's right pane (cohesive build spec §4.1, D3, D4, D18): the
// company, read as a document (Read) or drawn as a map (Map), under one
// filter row both lenses share, with the sheets of the objects the person
// opened stacked over it. The top sheet takes up to 560px from the right and
// leaves at least 260px of the lens beside it, where the map rings the open
// object and the document stays live; on a pane too narrow for both the
// sheet covers the lens, which stays mounted underneath (its pan, zoom and
// scroll kept) and inert. Esc steps back through the stack, then closes.
import { useMemo, type ReactNode } from "react";
import { useEventListener } from "../../../hooks/useEventListener";
import { useMeasuredWidth } from "../../../hooks/useMeasuredWidth";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { cn } from "../../../lib/utils";
import { ORG_BAND, ORG_GUTTER, ORG_RULE } from "../orgFrame";
import { OrgSegmented } from "../OrgSegmented";
import { CompanyDocument } from "../../company/CompanyDocument";
import type { MapFilter } from "../OrgMap";
import type { OrgGraphObject } from "../OrgGraph";
import { findGoal, findPerson, findProject, findRole } from "./objects";
import { SHEETS } from "./sheetRegistry";
import { SheetHostContext, type SheetHost } from "./sheetHost";
import { DOC_KEEP_W, sheetId, sheetKey, sheetWidth, type SheetRef } from "./sheetStack";
import { useCompanyRows, type CompanyRows } from "./useCompanyRows";
import "./company.css";

export type CompanyLens = "read" | "map";

const FILTERS: { key: MapFilter; label: string; title: string }[] = [
  { key: "everything", label: "Everything", title: "The mission, its goals and projects, and the people and roles beside them" },
  { key: "goals", label: "Goals", title: "The goals and the projects that carry them" },
  { key: "projects", label: "Projects", title: "Every project, under the goal it serves" },
  { key: "people", label: "People", title: "Who reports to whom, people and roles" },
];

const LENSES = [{ key: "read", label: "Read" }, { key: "map", label: "Map" }] as const;

/** Below these pane widths the head's row no longer fits on one line (the
 *  lens, the filters and, on the map, its corner), so it may wrap. Above
 *  them the head keeps the band height and its rule meets the strip's. */
const ONE_LINE_W = { read: 420, map: 720 } as const;

/** The row id a sheet's object carries on the map. */
function graphObjectOf(s: SheetRef | null | undefined, rows: CompanyRows): OrgGraphObject | null {
  if (!s) return null;
  if (s.kind === "initiative") { const g = findGoal(rows.goals, s.ref); return g ? { kind: s.kind, id: g._id } : null; }
  if (s.kind === "project") { const p = findProject(rows.projects, s.ref); return p ? { kind: s.kind, id: p._id } : null; }
  if (s.kind === "role") { const r = findRole(rows.tree, s.ref); return r ? { kind: s.kind, id: r._id } : null; }
  const { person, member } = findPerson(rows.tree, rows.members, s.ref);
  const id = person?.user_id ?? (member ? String(member._id) : null);
  return id ? { kind: "person", id } : null;
}

/** A sheet's object by name, for Back: "← Increase top of funnel". */
function titleOf(s: SheetRef | null | undefined, rows: CompanyRows): string | null {
  if (!s) return null;
  if (s.kind === "initiative") return findGoal(rows.goals, s.ref)?.title ?? null;
  if (s.kind === "project") return findProject(rows.projects, s.ref)?.title ?? null;
  if (s.kind === "role") return findRole(rows.tree, s.ref)?.name ?? null;
  const { person, member } = findPerson(rows.tree, rows.members, s.ref);
  return person?.name ?? member?.name ?? null;
}

export type CompanyPaneProps = {
  lens: CompanyLens;
  onLens: (lens: CompanyLens) => void;
  filter: MapFilter;
  onFilter: (filter: MapFilter) => void;
  /** The open sheets, the top last. */
  stack: readonly SheetRef[];
  /** What a sheet asks of the screen; the pane adds the step under it and whether it covers. */
  host: Omit<SheetHost, "under" | "underTitle" | "covers">;
  /** The map's corner (As proposed, Following), drawn in the header row while the map shows. */
  corner?: ReactNode;
  /** The map, given the open object to ring and the room the sheet takes from its right. */
  renderMap: (p: { ring: OrgGraphObject | null; panelWidth: number }) => ReactNode;
  /** The pane takes the whole column (stacked, or no conversation beside it). */
  className?: string;
};

export function CompanyPane({ lens, onLens, filter, onFilter, stack, host, corner, renderMap, className }: CompanyPaneProps) {
  const rows = useCompanyRows();
  const { width, measureRef } = useMeasuredWidth();
  const top = stack[stack.length - 1] ?? null;
  const under = stack.length > 1 ? stack[stack.length - 2] : null;
  const { width: sheetW, covers } = sheetWidth(width ?? 0, lens === "read" ? DOC_KEEP_W : undefined);
  const open = !!top && (width ?? 0) > 0;
  const ring = useMemo(() => graphObjectOf(top, rows), [top, rows]);
  const underTitle = titleOf(under, rows);
  const wraps = width !== null && width < ONE_LINE_W[lens === "map" && corner ? "map" : "read"];
  const hostValue = useMemo<SheetHost>(() => ({ ...host, under, underTitle, covers }), [host, under, underTitle, covers]);

  // Esc walks back through the stack, then closes (D4), unless the key is a
  // field's (a draft, a rename) or a region that owns its keys.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || keyBelongsElsewhere(e.target)) return;
    // A key pressed in another pane (a split beside the screen) is that pane's.
    const t = e.target as Element | null;
    if (t instanceof Element && t !== document.body && !t.closest("[data-org-screen], [data-company-pane]")) return;
    // An open menu or modal takes its own Esc first.
    if (document.querySelector("[role=menu][data-state=open], [role=dialog][data-state=open], [role=alertdialog]")) return;
    e.preventDefault();
    if (under) host.back(); else host.close();
  }, top ? window : null);

  const Sheet = top ? SHEETS[top.kind] : null;
  return (
    <SheetHostContext.Provider value={hostValue}>
      <div className={cn("flex h-full min-h-0 flex-col", className)} style={{ background: "var(--sol-bg)" }} data-company-pane={lens} data-company-filter={filter} data-company-sheets={stack.length}>
        <div className={cn("flex shrink-0 items-center gap-x-3 border-b", ORG_GUTTER, wraps ? "min-h-11 flex-wrap gap-y-1.5 py-1.5" : ORG_BAND)} style={{ borderColor: ORG_RULE }} data-company-head data-company-head-wraps={wraps ? "" : undefined}>
          <OrgSegmented value={lens} onChange={onLens} items={LENSES} label="Read or map" data="company-lens" />
          <div className="flex min-w-0 items-center gap-3.5 text-[12px]" role="group" aria-label="What the company shows" data-map-filter-row={filter}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => onFilter(f.key)}
                aria-pressed={filter === f.key}
                title={f.title}
                className="py-[3px] transition-colors hover:text-[var(--sol-text-secondary)]"
                style={filter === f.key ? { color: "var(--sol-text)", boxShadow: "inset 0 -1.5px 0 var(--sol-text)" } : { color: "var(--sol-text-dim)" }}
                data-company-filter-pick={f.key}
              >
                {f.label}
              </button>
            ))}
          </div>
          {lens === "map" && corner && <div className="ml-auto flex items-center gap-1.5">{corner}</div>}
        </div>

        <div ref={measureRef} className="relative min-h-0 flex-1 overflow-hidden" data-company-body>
          {/* The lens stays mounted under a sheet; covered whole, it takes no focus or clicks. */}
          <div className="absolute inset-0" inert={open && covers ? true : undefined} data-company-lens-body={lens}>
            {lens === "map" ? (
              renderMap({ ring, panelWidth: open && !covers ? sheetW : 0 })
            ) : (
              <div className="h-full overflow-y-auto ol-doc-scroll" style={{ paddingRight: open && !covers ? sheetW : 0 }} data-company-read>
                <CompanyDocument filter={filter} selected={top?.ref ?? null} />
              </div>
            )}
          </div>
          {open && Sheet && top && (
            <div
              key={sheetId(top)}
              className="org-sheet absolute bottom-0 right-0 top-0 z-10 flex flex-col"
              style={{
                width: sheetW,
                background: "var(--sol-bg)",
                borderLeft: covers ? "none" : "1px solid var(--sol-border)",
                boxShadow: covers ? "none" : "-24px 0 48px -28px rgba(0,0,0,.6)",
              }}
              role="complementary"
              aria-label={titleOf(top, rows) ?? "Sheet"}
              data-company-sheet={sheetKey(top)}
              data-sheet-covers={covers ? "" : undefined}
            >
              <Sheet sheet={top} />
            </div>
          )}
        </div>
      </div>
    </SheetHostContext.Provider>
  );
}
