// The area's local nav: the mark, the three sections (Surfaces, Bisects,
// Multiplayer sim), a search box that takes a surface, run id, batch, freeze
// id prefix or sha, and a status line for the machine the evals are read from.

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import type { FreezeResponse, OverviewResponse, SurfaceResponse } from "@codecast/shared/contracts/evalsApi";
import { useEvalsStore } from "../../store/evalsStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { evalsHref, evalsSearchTargets, evalsSection, type EvalsSearchKnown, type EvalsView } from "./evalsPaths";
import { EvalsLink, shortSha } from "./parts";

const SECTIONS = [
  { key: "surfaces", label: "Surfaces", href: evalsHref.home() },
  { key: "bisects", label: "Bisects", href: evalsHref.bisectList() },
  { key: "sim", label: "Multiplayer sim", href: evalsHref.sim() },
] as const;

/** The mark: a six-well plate, one well passing and one failing. */
function PlateMark() {
  return (
    <svg className="ev-mark-flask" viewBox="0 0 18 18" aria-hidden>
      <rect x={1} y={3.5} width={16} height={11} rx={2.5} fill="none" stroke="currentColor" strokeWidth={1.2} opacity={0.7} />
      {[5, 9, 13].map((cx, i) => (
        <g key={cx}>
          <circle cx={cx} cy={7} r={1.6} className={i === 0 ? "ev-pass" : "ev-quiet"} fill={i === 0 ? "currentColor" : "none"} stroke="currentColor" strokeWidth={0.9} />
          <circle cx={cx} cy={11} r={1.6} className={i === 2 ? "ev-fail" : "ev-quiet"} fill="none" stroke="currentColor" strokeWidth={i === 2 ? 1.2 : 0.9} />
        </g>
      ))}
    </svg>
  );
}

/** What the search can resolve without asking: everything a page has already loaded. */
function useSearchKnown(): EvalsSearchKnown {
  const resources = useEvalsStore((s) => s.resources);
  return useMemo(() => {
    const surfaces = new Set<string>();
    const batches: Record<string, string[]> = {};
    const freezes = new Map<string, string>();
    const addBatch = (b: string, s: string) => {
      const list = (batches[b] ??= []);
      if (!list.includes(s)) list.push(s);
    };
    for (const [key, res] of Object.entries(resources)) {
      if (!res.data) continue;
      if (key.startsWith("GET /overview")) {
        for (const s of (res.data as OverviewResponse).surfaces) {
          surfaces.add(s.id);
          for (const b of s.strip) addBatch(b.batch, s.id);
        }
      } else if (key.startsWith("GET /surface/")) {
        const d = res.data as SurfaceResponse;
        surfaces.add(d.surface.id);
        for (const b of d.batches) addBatch(b.batch, d.surface.id);
        for (const row of d.ledger) freezes.set(row.freezeId, row.name);
      } else if (key.startsWith("GET /freeze/")) {
        const d = res.data as FreezeResponse;
        freezes.set(d.freeze.id, d.freeze.name);
      }
    }
    return { surfaces: [...surfaces], batches, freezes: [...freezes].map(([id, name]) => ({ id, name })) };
  }, [resources]);
}

function EvalsSearch() {
  const router = useRouter();
  const known = useSearchKnown();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const targets = useMemo(() => evalsSearchTargets(q, known), [q, known]);
  // The surfaces and their batches come from the wall's answer: fetch it when
  // the box is used, so it works from any view (cached, shared with the wall).
  const wantKnown = () => {
    if (useEvalsStore.getState().connection === "connected") void useEvalsStore.getState().load("GET /overview", {});
  };
  const go = (href: string) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    router.push(href);
  };
  return (
    <div className="ev-search" data-evals-search>
      <Search className="ev-search-icon" />
      <input
        ref={input}
        value={q}
        placeholder="surface, run, batch, freeze or sha"
        aria-label="Search the evals"
        spellCheck={false}
        onChange={(e) => {
          wantKnown();
          setQ(e.target.value);
          setSel(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          wantKnown();
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((i) => Math.min(i + 1, targets.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && targets[sel]) {
            e.preventDefault();
            go(targets[sel].href);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      {open && q.trim() && (
        <div className="ev-search-list" role="listbox">
          {targets.length ? (
            targets.map((t, i) => (
              <button
                key={t.href}
                type="button"
                role="option"
                aria-selected={i === sel}
                className="ev-search-item"
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(t.href);
                }}
              >
                <span className="ev-search-kind">{t.kind}</span>
                <span className="ev-mono truncate">{t.label}</span>
              </button>
            ))
          ) : (
            <div className="ev-search-empty">Nothing here matches. A run id, a batch stamp, a freeze id prefix or a sha works.</div>
          )}
          {targets.length > 0 && (
            <div className="flex items-center gap-3 px-2 pt-1.5 pb-0.5 text-[10.5px] ev-quiet">
              <span className="inline-flex items-center gap-1">
                <KeyCap size="xs">↑</KeyCap>
                <KeyCap size="xs">↓</KeyCap> choose
              </span>
              <span className="inline-flex items-center gap-1">
                <KeyCap size="xs">Enter</KeyCap> open
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Status() {
  const health = useEvalsStore((s) => s.health);
  const transport = useEvalsStore((s) => s.transport?.kind ?? null);
  const connection = useEvalsStore((s) => s.connection);
  if (connection !== "connected" || !health) return null;
  return (
    <span className="ev-status" data-evals-status>
      {transport === "fixture" && (
        <span className="ev-chip ev-chip--dirty" title="Answered by the dev fixture world (localStorage EVALS_FIXTURE), not this machine's evals">
          fixture
        </span>
      )}
      <span className="ev-tabular" title={`EVALS_HOME ${health.evalsHome}`}>
        {health.runsIndexed.toLocaleString()} runs
      </span>
      <span className="ev-mono" title={`The eval tool runs from ${health.root} at ${health.gitHead ?? "an unknown head"}`}>
        tool {shortSha(health.gitHead)}
      </span>
    </span>
  );
}

export function EvalsNav({ view }: { view: EvalsView }) {
  const section = evalsSection(view);
  return (
    <nav className="ev-nav" aria-label="Evals" data-evals-nav>
      <EvalsLink href={evalsHref.home()} className="ev-mark">
        <PlateMark />
        <span className="ev-mark-word">Evals</span>
      </EvalsLink>
      <div className="ev-tabs">
        {SECTIONS.map((s) => (
          <EvalsLink key={s.key} href={s.href} className="ev-tab" aria-current={section === s.key ? "page" : undefined} data-evals-section={s.key}>
            {s.label}
          </EvalsLink>
        ))}
      </div>
      <span className="ev-nav-spacer" />
      <EvalsSearch />
      <Status />
    </nav>
  );
}
