// The one source control in the Ops header: "Source: All" until a source is
// picked, then that source as a token with a clear button. It opens a
// searchable list grouped by provider, each source with its health and its
// open issues, so twenty sources cost the header one control. `/` opens it.
import { useContext, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ProviderIcon, SOURCE_PROVIDER_LABEL, SourceHealthContext } from "./parts";
import { groupSources, healthBad } from "./opsHomeModel";
import { issueTotals, openFeederFull } from "./issuesModel";
import { OPS_OPEN_GROUPS_LIMIT, useOpsGroups } from "../../hooks/useSyncOps";
import type { OpsSource } from "./opsTypes";


export function OpsSourceFilter({ sources, value, hrefFor }: { sources: OpsSource[]; value: string | null; hrefFor: (name: string | null) => string }) {
  const [open, setOpen] = useState(false);
  const healthMap = useContext(SourceHealthContext);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const picked = value ? sources.find((s) => s.name === value) : undefined;
  // Open issues by the Issues tab's own rule, so the number here is the one that tab shows for the source.
  const allGroups = useOpsGroups();
  const openOf = useMemo(() => {
    const capped = openFeederFull(allGroups, OPS_OPEN_GROUPS_LIMIT);
    return new Map(sources.map((s) => [s._id, issueTotals(allGroups, sources, s._id, capped).open]));
  }, [sources, allGroups]);
  const groups = useMemo(() => groupSources(sources, q), [sources, q]);
  const flat = useMemo(() => [null, ...groups.flatMap((g) => g.sources.map((s) => s.name))].filter((n, i) => i > 0 || !q.trim()), [groups, q]);

  useWatchEffect(() => setCursor(0), [q, open]);
  useWatchEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (name: string | null) => {
    setOpen(false);
    setQ("");
    router.push(hrefFor(name));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setCursor((c) => Math.min(flat.length - 1, c + 1));
    else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
    else if (e.key === "Enter" && flat.length) go(flat[cursor] ?? null);
    else return;
    e.preventDefault();
  };
  if (!sources.length) return null;

  return (
    <div className="ops-filter" data-ops-source-filter={value ?? ""}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="ops-filter-btn" data-on={picked ? "true" : undefined} aria-label={picked ? `Source: ${picked.name}` : value ? `Source: ${value}, not in this workspace` : "Source: all"}>
            {picked ? (
              <>
                <span className="ops-dot" data-status={picked.status} data-health={healthMap?.get(picked._id)?.tone} />
                <ProviderIcon provider={picked.provider} />
                <span className="truncate min-w-0">{picked.name}</span>
              </>
            ) : value ? (
              // A name no source here answers to: said struck through, never "All" while the page names it.
              <>
                <span className="ops-dim">Source</span>
                <s className="truncate min-w-0 ops-dim" data-ops-source-missing>{value}</s>
              </>
            ) : (
              <>
                <span className="ops-dim">Source</span>
                <span>All</span>
                <span className="ops-filter-n ops-num">{sources.length}</span>
              </>
            )}
            <ChevronDown className="w-3.5 h-3.5 ops-dim" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="ops-filter-pop" onOpenAutoFocus={(e) => { e.preventDefault(); listRef.current?.querySelector("input")?.focus(); }}>
          <div ref={listRef}>
            <div className="ops-filter-search">
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder="Find a source" aria-label="Find a source" />
              <KeyCap size="xs">/</KeyCap>
            </div>
            <div className="ops-filter-list" role="listbox" aria-label="Sources">
              {!q.trim() && (
                <button type="button" role="option" aria-selected={!value} className="ops-filter-row" data-cursor={cursor === 0 ? "true" : undefined} onClick={() => go(null)}>
                  <span className="ops-filter-name">All sources</span>
                  <span className="ops-num ops-dim">{sources.length}</span>
                </button>
              )}
              {groups.map((g) => (
                <div key={g.provider} role="group" aria-label={SOURCE_PROVIDER_LABEL[g.provider]}>
                  <div className="ops-filter-group"><ProviderIcon provider={g.provider} />{SOURCE_PROVIDER_LABEL[g.provider]}</div>
                  {g.sources.map((s) => {
                    const i = flat.indexOf(s.name);
                    // The area's one reading (sourceHealth.ts via SourceHealthContext).
                    const shared = healthMap?.get(s._id);
                    const health = { label: shared?.label ?? s.status, bad: healthBad(shared), tone: shared?.tone };
                    return (
                      <button key={s._id} type="button" role="option" aria-selected={value === s.name} className="ops-filter-row" data-cursor={cursor === i ? "true" : undefined} onClick={() => go(s.name)} title={shared?.reason ? `${s.name}: ${shared.reason}` : s.last_error ? `${s.name}: ${s.last_error}` : `${s.name} · ${health.label}`}>
                        <span className="ops-dot" data-status={health.bad ? "error" : s.status} data-health={health.tone} />
                        <span className="ops-filter-name truncate">{s.name}</span>
                        {health.bad && <span className="ops-filter-health">{health.label}</span>}
                        {(openOf.get(s._id) ?? 0) > 0 && <span className="ops-num ops-filter-open">{openOf.get(s._id)!.toLocaleString()}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {!groups.length && <div className="ops-filter-none">No source matches</div>}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {picked && (
        <Link href={hrefFor(null)} className="ops-filter-clear" aria-label={`Clear source ${picked.name}`} title="All sources">
          <X className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}
