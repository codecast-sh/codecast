"use client";

import { useState, type ReactNode } from "react";
import { Person, Section, SessionDot, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, PAPER, SAND, SOL, STATE, TEXT, person, role, tint } from "./model";
import { PARTS, partNo, type AnatomyTab, type PartId } from "./anatomyData";
import { AnatomyDay } from "./AnatomyDay";

/*
 * What a role is: the Release Captain's page as the app draws it, with the
 * parts a reader can point at numbered around it. Pointing at a callout lights
 * its part on the page and opens the tab that holds it. The resting state is
 * the Brief tab with nothing lit, which reads complete on its own. Under it,
 * one day of the same role on a 24-hour line.
 */

const HI = SOL.orange;

const CSS = `
.og-a-part { position: relative; border-radius: 10px; transition: box-shadow .18s ease, background-color .18s ease; }
.og-a-part[data-on="true"] { box-shadow: 0 0 0 2px ${HI}, 0 0 0 8px ${tint(HI, 18, "transparent")}; background-color: ${tint(HI, 9, "transparent")}; }
.og-a-no { transition: background-color .18s ease, color .18s ease, transform .18s ease; }
.og-a-part[data-on="true"] > .og-a-no { background-color: ${HI}; color: ${PAPER}; box-shadow: none; transform: scale(1.1); }
.og-a-call { transition: background-color .15s ease, border-color .15s ease; }
.og-a-call[data-on="true"] { background-color: ${tint(HI, 10)}; border-color: ${tint(HI, 50)}; }
.og-a-call[data-on="true"] .og-a-callno { background-color: ${HI}; color: ${PAPER}; }
.og-a-tabpane { animation: og-fade .25s ease both; }
@media (prefers-reduced-motion: reduce) { .og-a-part, .og-a-no, .og-a-call { transition: none; } .og-a-tabpane { animation: none; } }
.og-root[data-static] .og-a-tabpane { animation: none; }
`;

/** A numbered marker on the mock, matching its callout. */
function No({ id }: { id: PartId }) {
  return (
    <span aria-hidden className="og-a-no inline-flex w-[22px] h-[22px] mt-px rounded-full items-center justify-center font-mono text-[11.5px] font-bold" style={{ backgroundColor: tint(HI, 14, PAPER), color: SOL.orange, boxShadow: `inset 0 0 0 1.5px ${tint(HI, 55, PAPER)}` }}>
      {partNo(id)}
    </span>
  );
}

/** A part of the mock a callout can light. */
function Part({ id, on, children, className = "" }: { id: PartId; on: PartId | null; children: ReactNode; className?: string }) {
  return (
    <div className={`og-a-part grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5 items-start ${className}`} data-on={on === id}>
      <No id={id} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const H = ({ children }: { children: ReactNode }) => (
  <div className="font-mono text-[11px] font-semibold mb-1.5" style={{ color: DIM }}>{children}</div>
);

function Chip({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] whitespace-nowrap" style={{ borderColor: LINE, backgroundColor: PAPER, color: TEXT }}>
      <span style={{ color: DIM }}>{kind}</span>{children}
    </span>
  );
}

// ---- Tabs ------------------------------------------------------------------

function BriefTab({ on }: { on: PartId | null }) {
  const book: [string, ReactNode][] = [
    ["North metric", <>Days from merge to store: <b style={{ color: INK }}>2.4</b> <span style={{ color: DIM }}>target 2</span></>],
    ["Rules learned", <>Rerun a flaky iOS test twice, then quarantine it. <span style={{ color: DIM }}>from 4.10</span></>],
    ["Refuted", <>Friday releases crash more. <span style={{ color: DIM }}>14 releases, no difference</span></>],
    ["Standing decisions", <>No release while checkout errors are open. <span style={{ color: DIM }}>Maya, Oct 28</span></>],
    ["Open threads", <>Android signing key expires <span style={{ color: SOL.yellow }}>due Nov 20</span></>],
  ];
  return (
    <Part id="brief" on={on} className="p-3 -m-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
        <span className="font-mono text-[11px]" style={{ color: MUTED }}>written by @release</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px]" style={{ color: DIM }}>
          <span className="w-20 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: SAND }}>
            <span className="block h-full rounded-full" style={{ width: "68%", backgroundColor: SOL.base1 }} />
          </span>
          8,140 / 12,000
        </span>
      </div>
      <div className="font-mono text-[13px] font-semibold leading-snug" style={{ color: INK }}>Cutting 4.12 for Monday; 6 PRs merged since 4.11.</div>
      <div className="mt-4">
        <H>Where it stands</H>
        <ul className="space-y-1 text-[12.5px] leading-5" style={{ color: BODY }}>
          <li className="rounded px-1.5 -mx-1.5" style={{ backgroundColor: tint(SOL.green, 10) }}><span className="font-mono text-[11px] mr-2" style={{ color: SOL.green }}>Nov 5</span>4.12 rebuilt with the checkout fix; ships Monday.</li>
          <li><span className="font-mono text-[11px] mr-2" style={{ color: DIM }}>Nov 3</span>4.11 hotfix live on 100% of iOS.</li>
          <li><span className="font-mono text-[11px] mr-2" style={{ color: DIM }}>Oct 31</span>App Store review back to one day.</li>
        </ul>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {book.map(([h, v], i) => (
          <div key={h} className={`rounded-lg border px-2.5 py-2 ${i === 0 ? "sm:col-span-2" : ""}`} style={{ borderColor: LINE, backgroundColor: PAPER }}>
            <div className="font-mono text-[10.5px] font-semibold" style={{ color: DIM }}>{h}</div>
            <div className="text-[12.5px] leading-5" style={{ color: TEXT }}>{v}</div>
          </div>
        ))}
      </div>
    </Part>
  );
}

function CharterTab({ on }: { on: PartId | null }) {
  const maya = person("maya");
  return (
    <Part id="charter" on={on} className="p-3 -m-1">
      <div className="flex items-center gap-2 mb-3 font-mono text-[11px]" style={{ color: MUTED }}>
        <Person p={maya} size={18} /> written by Maya Chen
        <span className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5" style={{ backgroundColor: SAND, color: MUTED }}>
          <LockGlyph /> read only for @release
        </span>
      </div>
      <div className="space-y-2.5 text-[13px] leading-[1.6]" style={{ color: TEXT }}>
        <p>Own what ships and when, for the iOS and Android apps and the web app.</p>
        <p>Walk the merge train every day. Cut a release when main is green and checkout errors are under 0.1%.</p>
        <p>Ask Maya before a Friday release.</p>
        <p style={{ color: MUTED }}>Not yours: writing features, changing the roadmap.</p>
      </div>
      <div className="mt-4 flex justify-end">
        <span className="og-press rounded-md border px-2.5 py-1 font-mono text-[11px]" style={{ borderColor: LINE, color: TEXT, backgroundColor: PAPER }}>Edit</span>
      </div>
    </Part>
  );
}

function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function SessionsTab() {
  const rows: [string, string, "working" | "done"][] = [
    ["Rebuild with fix", "1h 06m", "done"],
    ["Quarantine flaky test", "48m", "done"],
    ["Cut release 4.12", "1h 12m", "done"],
  ];
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[11px] mb-2" style={{ color: MUTED }}>3 sessions under it · <span style={{ color: SOL.cyan }}>3 done</span></div>
      {rows.map(([t, d, s]) => (
        <div key={t} className="flex items-center gap-2.5 rounded-lg border px-3 py-2" style={{ borderColor: LINE, backgroundColor: PAPER }}>
          <SessionDot state={s} />
          <span className="text-[12.5px] truncate" style={{ color: TEXT }}>{t}</span>
          <span className="ml-auto font-mono text-[11px] whitespace-nowrap" style={{ color: DIM }}>{STATE[s].word} · {d}</span>
        </div>
      ))}
    </div>
  );
}

function TriggersTab({ on }: { on: PartId | null }) {
  const rows: [string, string, string][] = [
    ["Check What ships, and when", "every 6h · only when main has new merges", "last 15:00 ran · next 21:00"],
    ["A session under you needs input", "when a worker asks", "last 10:40"],
  ];
  return (
    <Part id="triggers" on={on} className="p-2 -m-1">
      {rows.map(([t, when, last]) => (
        <div key={t} className="rounded-lg border px-3 py-2.5 mb-2 last:mb-0" style={{ borderColor: LINE, backgroundColor: PAPER }}>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: SOL.green }} />
            <span className="text-[13px] font-semibold truncate" style={{ color: INK }}>{t}</span>
            <span className="ml-auto hidden sm:flex gap-1.5">
              {["Pause", "Edit"].map((v) => (
                <span key={v} className="rounded-md border px-2 py-0.5 font-mono text-[10.5px]" style={{ borderColor: LINE, color: MUTED }}>{v}</span>
              ))}
            </span>
          </div>
          <div className="mt-1 pl-3.5 font-mono text-[11px] leading-4" style={{ color: MUTED }}>{when}</div>
          <div className="pl-3.5 font-mono text-[11px] leading-4" style={{ color: DIM }}>{last}</div>
        </div>
      ))}
    </Part>
  );
}

function SettingsTab({ on }: { on: PartId | null }) {
  const [open, setOpen] = useState(false);
  const limitsOpen = open || on === "limits";
  const grants: [string, string, string, string][] = [
    ["publish", "App Store and Play Store", "2 releases a week", "until Dec 31 · Maya"],
    ["write", "GitHub release notes", "public repo only", "until Jan 31 · Leo"],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[100px_1fr] gap-y-2 text-[12.5px]">
        <span className="font-mono text-[11px] pt-0.5" style={{ color: DIM }}>Reports to</span>
        <span className="flex items-center gap-1.5" style={{ color: TEXT }}><Tile k={role("eng").k} size={16} />Engineering lead</span>
        <span className="font-mono text-[11px] pt-0.5" style={{ color: DIM }}>Tenure</span>
        <span style={{ color: TEXT }}>standing</span>
      </div>
      <Part id="switch" on={on} className="px-3 py-2.5 -mx-1">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold" style={{ color: INK }}>Starts work on its own</span>
          <span role="switch" aria-checked="true" aria-label="Starts work on its own" className="ml-auto inline-flex w-9 h-5 rounded-full p-0.5 shrink-0" style={{ backgroundColor: SOL.green }}>
            <span className="w-4 h-4 rounded-full ml-auto" style={{ backgroundColor: PAPER }} />
          </span>
        </div>
      </Part>
      <Part id="limits" on={on} className="-mx-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={limitsOpen} className="og-press w-full flex items-center gap-2 px-3 py-2 text-left">
          <span className="font-mono text-[10px] transition-transform" style={{ color: DIM, transform: limitsOpen ? "rotate(90deg)" : "none" }}>▶</span>
          <span className="text-[13px]" style={{ color: TEXT }}>Limits</span>
          <span className="ml-auto font-mono text-[11px]" style={{ color: DIM }}>none set</span>
        </button>
        {limitsOpen && (
          <div className="px-3 pb-2.5 grid grid-cols-[1fr_auto] gap-y-1 font-mono text-[11.5px]">
            {["sessions started a day", "wakes a day", "tokens a day"].map((l) => (
              <span key={l} className="contents"><span style={{ color: MUTED }}>{l}</span><span style={{ color: DIM }}>no limit</span></span>
            ))}
          </div>
        )}
      </Part>
      <Part id="perms" on={on} className="p-2.5 -mx-1">
        <div className="flex items-center mb-2">
          <span className="text-[13px] font-semibold" style={{ color: INK }}>Permissions outside codecast</span>
          <span className="ml-auto rounded-md border px-2 py-0.5 font-mono text-[10.5px]" style={{ borderColor: LINE, color: MUTED }}>+ Grant</span>
        </div>
        <div className="space-y-1.5">
          {grants.map(([verb, what, limit, until]) => (
            <div key={verb} className="grid grid-cols-[62px_1fr] gap-x-2 rounded-lg border px-2.5 py-1.5" style={{ borderColor: LINE, backgroundColor: PAPER }}>
              <span className="font-mono text-[11px] font-semibold pt-px" style={{ color: SOL.orange }}>{verb}</span>
              <span className="min-w-0">
                <span className="block text-[12.5px] truncate" style={{ color: TEXT }}>{what}</span>
                <span className="block font-mono text-[10.5px]" style={{ color: DIM }}>{limit} · {until}</span>
              </span>
            </div>
          ))}
        </div>
      </Part>
    </div>
  );
}

// ---- The page mock ---------------------------------------------------------

const TABS: [AnatomyTab, string, string?][] = [["brief", "Brief"], ["charter", "Charter"], ["sessions", "Sessions", "3"], ["triggers", "Triggers", "2"], ["settings", "Settings"]];

function RolePage({ tab, setTab, on }: { tab: AnatomyTab; setTab: (t: AnatomyTab) => void; on: PartId | null }) {
  const r = role("release");
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 30px 70px -40px rgba(0,43,54,.45)" }}>
      <div className="px-4 h-9 flex items-center gap-1.5 border-b font-mono text-[11.5px]" style={{ borderColor: LINE, color: DIM, backgroundColor: tint(SAND, 50) }}>
        Org <span>/</span> <span style={{ color: MUTED }}>Release Captain</span>
      </div>
      <div className="px-4 sm:px-5 pt-5 pb-4 border-b" style={{ borderColor: LINE }}>
        <div className="flex items-start gap-3.5">
          <Tile k={r.k} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono font-bold text-[18px] tracking-[-0.02em]" style={{ color: INK }}>{r.title}</span>
              <span className="font-mono text-[12px]" style={{ color: DIM }}>{r.handle}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px]" style={{ color: MUTED }}>
              reports to <Tile k={role("eng").k} size={15} /> <span style={{ color: TEXT }}>Engineering lead</span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 font-mono text-[12px] min-w-0">
              <SessionDot state="working" size={7} />
              <span style={{ color: SOL.green }}>working</span>
              <span className="truncate" style={{ color: TEXT }}>· Cutting 4.12 for Monday</span>
            </div>
          </div>
        </div>
        <Part id="area" on={on} className="mt-4 px-2.5 py-2 -mx-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] mr-1" style={{ color: DIM }}>Area</span>
            <span className="text-[12.5px] mr-1" style={{ color: TEXT }}>{r.area}</span>
            <Chip kind="project">Mobile releases</Chip>
            <Chip kind="plan">Ship 4.12</Chip>
          </div>
        </Part>
      </div>
      <div role="tablist" className="flex gap-1 px-3 sm:px-4 border-b overflow-x-auto" style={{ borderColor: LINE }}>
        {TABS.map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className="og-press relative px-2.5 py-2.5 font-mono text-[12px] whitespace-nowrap"
            style={{ color: tab === id ? INK : MUTED, fontWeight: tab === id ? 600 : 400 }}
          >
            {label}{n && <span className="ml-1" style={{ color: DIM }}>{n}</span>}
            {tab === id && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ backgroundColor: INK }} />}
          </button>
        ))}
      </div>
      <div key={tab} role="tabpanel" className="og-a-tabpane p-4 sm:p-5 min-h-[380px]">
        {tab === "brief" && <BriefTab on={on} />}
        {tab === "charter" && <CharterTab on={on} />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "triggers" && <TriggersTab on={on} />}
        {tab === "settings" && <SettingsTab on={on} />}
      </div>
    </div>
  );
}

export function Anatomy() {
  const [tab, setTab] = useState<AnatomyTab>("brief");
  const [on, setOn] = useState<PartId | null>(null);
  const point = (id: PartId) => {
    setOn(id);
    const t = PARTS.find((p) => p.id === id)?.tab;
    if (t) setTab(t);
  };
  const active = PARTS.find((p) => p.id === on);
  return (
    <Section
      id="a-role"
      band
      title="What a role is"
      lede={<>A role is a standing agent. It keeps one long-lived session, answers for an area, and wakes on its own triggers to put workers on what comes up. You write its charter. It writes its brief, the notes it reads at every wake to pick up where it left off.</>}
    >
      <style>{CSS}</style>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:gap-10 items-start">
        <div className="min-w-0 order-2 lg:order-1">
          <RolePage tab={tab} setTab={setTab} on={on} />
        </div>
        <div className="order-1 lg:order-2 lg:pt-2">
          <ol className="flex flex-wrap gap-1.5 lg:block lg:space-y-1.5" onMouseLeave={() => setOn(null)}>
            {PARTS.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="og-a-call w-full text-left rounded-lg border px-2.5 py-1.5 lg:px-3 lg:py-2.5 flex lg:grid lg:grid-cols-[22px_1fr] items-center lg:items-start gap-2"
                  data-on={on === p.id}
                  style={{ borderColor: "transparent" }}
                  onMouseEnter={() => point(p.id)}
                  onFocus={() => point(p.id)}
                  onClick={() => point(p.id)}
                >
                  <span className="og-a-callno inline-flex w-[20px] h-[20px] rounded-full items-center justify-center font-mono text-[11px] font-bold shrink-0" style={{ backgroundColor: tint(HI, 22, SAND), color: TEXT }}>{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[12.5px] lg:text-[13.5px] font-semibold whitespace-nowrap" style={{ color: INK }}>{p.name}</span>
                    <span className="hidden lg:block mt-0.5 text-[13.5px] leading-[1.55]" style={{ color: MUTED }}>{p.says}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {active && <p className="lg:hidden mt-3 text-[14px] leading-[1.55]" style={{ color: MUTED }}>{active.says}</p>}
        </div>
      </div>

      <AnatomyDay />

    </Section>
  );
}
