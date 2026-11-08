"use client";

import { useState, type ReactNode } from "react";
import { BellOff, ChevronDown, KeyRound } from "lucide-react";
import { Frame, Person, Section, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, SOL, person, tint } from "./model";
import { LIFE_START, LOG_SEED, lifeEntry, type Life, type LifeChange, type LogEntry } from "./controlData";
import { ControlHistory } from "./ControlHistory";
import { ControlLife } from "./ControlLife";

/*
 * Control: one role's lifecycle (the switch, pause, restart, split, retire)
 * beside the org's History, where every press lands with Undo. Then the
 * quiet safety nets: daily limits and authority outside codecast.
 */

const CSS = `
.og-ctl-drop { animation-name: og-ctl-drop; animation-duration: .45s; }
.og-ctl-up { animation-name: og-ctl-up; animation-duration: .8s; }
@keyframes og-ctl-up { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
.og-ctl-fromR { animation-name: og-ctl-fromR; animation-duration: .75s; }
.og-ctl-fromL { animation-name: og-ctl-fromL; animation-duration: .75s; }
@keyframes og-ctl-drop { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes og-ctl-fromR { from { opacity: .3; transform: translateX(52%) scale(.92); } to { opacity: 1; transform: none; } }
@keyframes og-ctl-fromL { from { opacity: .3; transform: translateX(-52%) scale(.92); } to { opacity: 1; transform: none; } }
`;

const MAYA = person("maya").name;

export function Control() {
  const [entries, setEntries] = useState<LogEntry[]>(LOG_SEED);
  const [life, setLife] = useState<Life>(LIFE_START);
  const [tick, setTick] = useState(0);
  // A page clock that moves a minute per press, so a prerender and the
  // first paint agree.
  const clock = (n: number) => `11:${String(52 + n).padStart(2, "0")}`;

  const apply = (c: LifeChange, to: "before" | "after") => setLife((l) => ({ ...l, [c.key]: c[to] }));
  const push = (e: Omit<LogEntry, "id" | "day" | "at" | "actor">, mark?: (list: LogEntry[]) => LogEntry[]) => {
    const n = tick + 1;
    setTick(n);
    setEntries((list) => [{ ...e, id: `n${n}`, day: "Today", at: clock(n), actor: { kind: "person", id: "maya" } }, ...(mark ? mark(list) : list)]);
    return clock(n);
  };

  const onLife = (c: LifeChange) => { apply(c, "after"); push({ door: "settings", life: c, ...lifeEntry(c) }); };
  const onUndo = (id: string) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    if (e.life) apply(e.life, "before");
    const at = clock(tick + 1);
    push({ door: "history", gesture: "undo", line: `Undid "${e.line}"`, effects: e.undoEffects ?? [] },
      (list) => list.map((x) => x.id === id ? { ...x, undoneBy: { name: MAYA, at } } : x));
  };
  const onRedo = (id: string) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    if (e.life) apply(e.life, "after");
    push({ door: "history", gesture: "redo", line: `Applied again "${e.line}"`, effects: e.effects },
      (list) => list.map((x) => x.id === id ? { ...x, undoneBy: undefined } : x));
  };
  const onUndoShape = () => {
    const e = entries.find((x) => x.life?.key === "shape" && !x.undoneBy);
    if (e) onUndo(e.id);
  };
  const reset = tick > 0 ? () => { setEntries(LOG_SEED); setLife(LIFE_START); setTick(0); } : undefined;

  return (
    <Section
      id="control"
      title="Pause, split, retire, undo"
      lede={<p>Each role&apos;s Settings page has a switch for starting work on its own, plus Pause, Split and Retire. Before a split or retire, codecast copies what the role knows into the briefs that take over its area. Authority outside codecast comes only from a person. Every org change lands in one History, each with Undo.</p>}
    >
      <style>{CSS}</style>
      <Frame label={<><Tile k="share nodes" size={14} /> Social lead · Settings</>}>
        <ControlLife life={life} last={tick > 0 ? entries[0] : undefined} onChange={onLife} onUndoShape={onUndoShape}>
          <Limits />
          <AtLimit />
          <Authority />
        </ControlLife>
      </Frame>

      <Frame className="mt-5" label={<>Org · History <span className="ml-auto" style={{ color: DIM }}>{entries.length} changes</span></>}>
        <ControlHistory entries={entries} onUndo={onUndo} onRedo={onRedo} onReset={reset} />
      </Frame>
    </Section>
  );
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border p-3 bg-[#fffdf6]" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-2 mb-2 font-mono text-[11.5px] font-semibold" style={{ color: INK }}>{title}</div>
      {children}
    </div>
  );
}

function Limits() {
  const [open, setOpen] = useState(true);
  return (
    <Card title={<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="og-press inline-flex items-center gap-1.5">
      <ChevronDown className="w-3.5 h-3.5 transition-transform" style={{ transform: open ? undefined : "rotate(-90deg)", color: DIM }} />Limits <span className="font-normal" style={{ color: DIM }}>per day</span>
    </button>}>
      {open && (
        <ul className="space-y-1.5">
          {["Sessions started", "Wakes", "Tokens"].map((k) => (
            <li key={k} className="flex items-center gap-2 text-[12px]">
              <span className="flex-1" style={{ color: BODY }}>{k}</span>
              <span className="w-20 h-6 rounded-md border px-2 inline-flex items-center font-mono text-[11.5px]" style={{ borderColor: LINE, color: DIM }}>No limit</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AtLimit() {
  return (
    <Card title={<><Tile k="share nodes" size={16} /> Brief, at a limit</>}>
      <div className="rounded-md px-3 py-2 font-mono text-[11.5px] leading-snug" style={{ background: tint(SOL.yellow, 10, "#fffdf6"), color: INK }}>
        Nov 8 · At today&apos;s wake limit (12). Back tomorrow.
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11.5px]" style={{ color: MUTED }}>
        <BellOff className="w-3.5 h-3.5" /> No ping to you
      </div>
    </Card>
  );
}

const GRANTS: { what: string; limit: string; until: string; by: string }[] = [
  { what: "Publish", limit: "X, LinkedIn", until: "Jan 1", by: "maya" },
  { what: "Spend", limit: "$20 a day", until: "Dec 8", by: "ines" },
];

function Authority() {
  return (
    <Card title={<><KeyRound className="w-3.5 h-3.5" style={{ color: SOL.orange }} /> Outside codecast</>}>
      <ul className="space-y-1.5">
        {GRANTS.map((g) => (
          <li key={g.what} className="flex items-center gap-2 text-[12px] min-w-0">
            <span className="w-[52px] shrink-0 font-mono font-semibold" style={{ color: INK }}>{g.what}</span>
            <span className="truncate" style={{ color: BODY }}>{g.limit}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px]" style={{ color: DIM }}>until {g.until}</span>
            <Person p={person(g.by)} size={18} />
          </li>
        ))}
      </ul>
      <div className="mt-2 text-[11.5px]" style={{ color: MUTED }}>Granted by a person</div>
    </Card>
  );
}
