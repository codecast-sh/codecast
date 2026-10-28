"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { AuthGuard } from "../AuthGuard";
import { useInboxStore } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCapabilityFleet } from "./useCapabilityFleet";
import { buildFleetRows, isBroken, type FleetGridRow } from "./fleetRows";
import { CAPABILITY_KINDS, kindMeta, type CapabilityDevice } from "./kinds";
import { MachineDots } from "./MachineDots";
import { KitList } from "./KitList";
import { CapabilityPane, type Selection } from "./CapabilityPane";
import { kitKeyOf, useKitItems, useKitWorkspace, type KitConflict, type KitItem, type PendingConsent } from "./useKit";

/**
 * /capabilities: what your agents can use, and what your team shares.
 *
 * Two lists and one pane. The kit is what this workspace shares, each item
 * with who it is on for. Below it, everything your machines report, one kind at
 * a time, each row showing which machines have it. Opening any row shows the
 * real file and the one action that applies to it: share it, or turn it on.
 */

const SHAREABLE = new Set(["skill", "command", "subagent"]);
const NO_PENDING: PendingConsent[] = [];
const NO_CONFLICTS: KitConflict[] = [];

function rowKey(row: FleetGridRow): string {
  return kitKeyOf(String(row.kind), row.identity);
}

function matches(q: string, ...fields: Array<string | undefined>): boolean {
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

function CapabilitiesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { devices, reports, driftKeys, loading } = useCapabilityFleet();
  const ws = useKitWorkspace();
  const teamKit = useKitItems();
  // Your own kit applies to your machines whichever team is open, so a team
  // view shows it too, under the team's.
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const personalKey = meId ? `user:${meId}` : null;
  const personalWs = useKitWorkspace(personalKey);
  const personalKit = useKitItems(personalKey);
  const showPersonal = ws.kind === "team" && personalKit.length > 0;
  const kit = useMemo(() => (showPersonal ? [...teamKit, ...personalKit] : teamKit), [showPersonal, teamKit, personalKit]);
  const pending = (useQueryNoThrow(api.teamKit.webPendingConsents, {}).data ?? NO_PENDING) as PendingConsent[];
  const conflicts = (useQueryNoThrow(api.teamKit.webKitConflicts, {}).data ?? NO_CONFLICTS) as KitConflict[];

  const rows = useMemo(() => buildFleetRows(devices, reports, driftKeys), [devices, reports, driftKeys]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [rowKey(r), r])), [rows]);
  const kitByKey = useMemo(() => new Map(kit.map((k) => [kitKeyOf(k.kind, k.name), k])), [kit]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[String(r.kind)] = (c[String(r.kind)] ?? 0) + 1;
    return c;
  }, [rows]);
  const kinds = CAPABILITY_KINDS.filter((k) => (counts[k] ?? 0) > 0);

  const urlKind = params.get("kind");
  const kind = urlKind && kinds.includes(urlKind as any) ? urlKind : (kinds[0] ?? "skill");
  const setKind = (k: string) => router.replace(`${pathname ?? "/capabilities"}?kind=${k}`);

  const [query, setQuery] = useState("");
  const [onlyBroken, setOnlyBroken] = useState(false);
  const q = query.trim().toLowerCase();
  const [selection, setSelection] = useState<Selection | null>(null);

  // A search looks across every kind; otherwise one kind at a time.
  const visible = useMemo(
    () =>
      rows
        .filter((r) =>
          onlyBroken ? r.cells.some(isBroken) : q ? matches(q, r.identity, r.description) : String(r.kind) === kind,
        )
        .sort((a, b) => a.identity.localeCompare(b.identity)),
    [rows, q, kind, onlyBroken],
  );
  const visibleTeamKit = useMemo(() => teamKit.filter((k) => matches(q, k.name, k.description)), [teamKit, q]);
  const visiblePersonalKit = useMemo(() => personalKit.filter((k) => matches(q, k.name, k.description)), [personalKit, q]);

  // Keep the pane on the same thing when its data refreshes underneath it.
  const selectedRow = selection ? rowByKey.get(selection.key) : undefined;
  const selectedKit = selection ? kitByKey.get(selection.key) : undefined;
  useEffect(() => {
    if (selection && !selectedRow && !selectedKit) setSelection(null);
  }, [selection, selectedRow, selectedKit]);

  const broken = useMemo(() => rows.filter((r) => r.cells.some(isBroken)).length, [rows]);

  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className={`mx-auto w-full px-5 py-6 ${selection ? "max-w-[1320px]" : "max-w-[920px]"}`}>
        <header className="flex items-center gap-4 mb-6">
          <h1 className="text-lg font-serif text-sol-text">Capabilities</h1>
          <div className="flex items-center gap-3 text-xs text-sol-text-muted tabular-nums">
            <span>{devices.length} machines</span>
            <span>{rows.length} installed</span>
            {kit.length > 0 && <span>{kit.length} shared</span>}
            {broken > 0 && (
              <button
                type="button"
                onClick={() => setOnlyBroken((b) => !b)}
                aria-pressed={onlyBroken}
                className={`h-6 px-2 rounded-md border transition-colors ${
                  onlyBroken ? "border-sol-red text-sol-red bg-sol-bg-alt" : "border-transparent text-sol-red hover:border-sol-red"
                }`}
              >
                {broken} broken
              </button>
            )}
          </div>
          <div className="flex-1" />
          <label className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-sol-text-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search"
              className="h-8 w-56 pl-7 pr-2 text-xs bg-sol-bg-alt border border-sol-border rounded-md text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-blue"
            />
          </label>
        </header>

        <div className={selection ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 items-start" : ""}>
          <div className="min-w-0 space-y-8">
            <KitList
              title={ws.name}
              items={visibleTeamKit}
              rowFor={(k) => rowByKey.get(kitKeyOf(k.kind, k.name))}
              devices={devices}
              ws={ws}
              selectedKey={selection?.key ?? null}
              onOpen={(k) => setSelection({ key: kitKeyOf(k.kind, k.name) })}
              searching={!!q}
              pending={pending}
              conflicts={conflicts}
            />
            {showPersonal && (
              <KitList
                title={personalWs.name}
                items={visiblePersonalKit}
                rowFor={(k) => rowByKey.get(kitKeyOf(k.kind, k.name))}
                devices={devices}
                ws={personalWs}
                selectedKey={selection?.key ?? null}
                onOpen={(k) => setSelection({ key: kitKeyOf(k.kind, k.name) })}
                searching={!!q}
                pending={pending}
                conflicts={conflicts}
              />
            )}

            <section>
              <h2 className="text-sm font-medium text-sol-text mb-2">On your machines</h2>
              <div className="flex items-center gap-1 mb-2 border-b border-sol-border overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
                {!q && !onlyBroken &&
                  kinds.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      className={`px-2 pb-2 -mb-px text-xs border-b-2 transition-colors ${
                        k === kind
                          ? "border-sol-blue text-sol-text"
                          : "border-transparent text-sol-text-dim hover:text-sol-text-muted"
                      }`}
                    >
                      {kindMeta(k)?.plural ?? k}
                      <span className="ml-1 tabular-nums text-sol-text-dim">{counts[k]}</span>
                    </button>
                  ))}
                {(q || onlyBroken) && (
                  <span className="pb-2 text-xs text-sol-text-dim tabular-nums">
                    {onlyBroken ? `${visible.length} not downloaded somewhere` : `${visible.length} found`}
                  </span>
                )}
              </div>

              {loading ? (
                <RowSkeleton />
              ) : devices.length === 0 ? (
                <Empty text="No machines yet. Run cast start on a machine to see what its agents have." />
              ) : visible.length === 0 ? (
                <Empty text={q ? `Nothing matches "${query}"` : "Nothing reported yet"} />
              ) : (
                <ul>
                  {visible.map((r) => (
                    <MachineRow
                      key={r.key}
                      row={r}
                      devices={devices}
                      shared={kitByKey.has(rowKey(r))}
                      showKind={!!q || onlyBroken}
                      selected={selection?.key === rowKey(r)}
                      onOpen={() => setSelection({ key: rowKey(r) })}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>

          {selection && (
            <div className="sticky top-4 min-w-0">
              <CapabilityPane
                row={selectedRow}
                kitItem={selectedKit}
                devices={devices}
                ws={selectedKit && selectedKit.workspace === personalKey && ws.kind === "team" ? personalWs : ws}
                shareable={!!selectedRow && SHAREABLE.has(String(selectedRow.kind))}
                pending={pending}
                conflicts={conflicts}
                onClose={() => setSelection(null)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MachineRow({
  row,
  devices,
  shared,
  showKind,
  selected,
  onOpen,
}: {
  row: FleetGridRow;
  devices: CapabilityDevice[];
  shared: boolean;
  showKind: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const meta = kindMeta(String(row.kind));
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`w-full flex items-center gap-3 px-2 py-2 rounded-md text-left transition-colors ${
          selected ? "bg-sol-bg-alt" : "hover:bg-sol-bg-alt"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-sol-text truncate">{row.identity}</span>
            {showKind && <span className="text-[10px] text-sol-text-dim">{meta?.label}</span>}
            {shared && <span className="text-[10px] text-sol-blue">shared</span>}
          </span>
          {row.description && (
            <span className="block text-xs text-sol-text-muted truncate">{row.description}</span>
          )}
        </span>
        <MachineDots row={row} devices={devices} />
      </button>
    </li>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="px-2 py-6 text-xs text-sol-text-dim">{text}</p>;
}

function RowSkeleton() {
  return (
    <div className="space-y-3 px-2 py-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-8 rounded bg-sol-bg-alt animate-pulse" />
      ))}
    </div>
  );
}

export type { KitItem };

export default function CapabilitiesPage() {
  return (
    <AuthGuard>
      <CapabilitiesContent />
    </AuthGuard>
  );
}
