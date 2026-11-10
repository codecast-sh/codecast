"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { ForScripts, C, useStillMode } from "../kit";
import { Person, SessionDot, Section, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, PAPER, SAND, SOL, TEXT, accentOf, person, role, tint, type RoleRow } from "./model";
import { CONFIDENT, ITEMS, LINES, MARGIN, item, type Item, type Line, type Read } from "./routingData";

/*
 * Where new work lands. A reader picks an incoming item; it drops down a chute
 * through the four routing rules. A rule that does not match swings its gate
 * open and the item falls through; the rule that decides keeps its gate shut
 * and the item lands on it. The destination then shows who owns it.
 *
 * `tick` drives everything: 0 = in the hopper, k = resting on line k's gate
 * while it is tested, decide+1 = decided (router read revealed), DONE = the
 * destination shows. The resting state is DONE, so a prerender, ?static and
 * reduced motion all read the finished landing.
 */

const DONE = 99;
/** Rows 1-3 have a fixed height so the chute knows where each gate is; it grows on phones, where rules wrap. */
const ROW_H = "var(--og-routing-row)";
const GATE_Y = 50;
const PUCK = 16;
const STEP_MS = 520;

type RowState = "idle" | "testing" | "skip" | "decides" | "unreached";

function rowState(n: Line, decide: Line, s: number): RowState {
  if (n > decide) return "unreached";
  if (s < n) return "idle";
  if (s === n) return "testing";
  return n < decide ? "skip" : "decides";
}

/** The accent of whoever the item lands on (yellow while the router is unsure). */
function ownerAccent(it: Item, picked: string | null): string {
  const id = picked ?? (it.owner && "role" in it.owner ? it.owner.role : null);
  if (id) return accentOf(role(id).k);
  return it.owner ? SOL.base01 : SOL.yellow;
}

export function Routing() {
  const still = useStillMode();
  const [sel, setSel] = useState("signups");
  const [tick, setTick] = useState(DONE);
  const [run, setRun] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const it = item(sel);
  const stop = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useMountEffect(() => stop);

  // Drop the picked item: rest on each gate in turn, then land and show the owner.
  const pick = (id: string) => {
    stop();
    setSel(id);
    setPicked(null);
    setRun((n) => n + 1);
    if (still) { setTick(DONE); return; }
    setTick(0);
    const decide = item(id).decide;
    let t = 220;
    for (let k = 1; k <= decide + 1; k++) {
      const v = k;
      timers.current.push(setTimeout(() => setTick(v), t));
      t += k === decide ? 460 : STEP_MS;
    }
    timers.current.push(setTimeout(() => setTick(DONE), t + 120));
  };

  const s = Math.min(tick, it.decide + 2);
  const acc = ownerAccent(it, picked);
  const cmd = it.cmd ?? item("signups").cmd!;

  return (
    <Section
      id="routing"
      title="Where new work lands"
      band
      lede={
        <p>
          Work arrives from a webhook, a support inbox, a chat line, a plan or someone's laptop, and each piece gets exactly one owner. Four rules are tried in order and the first that matches decides. Every landing names its rule, so a misfiled task traces back to the line that filed it.
        </p>
      }
    >
      <style>{CSS}</style>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-5 gap-y-2 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)_minmax(0,4fr)] lg:grid-rows-[auto_1fr]">
        <Label className="lg:col-start-1 lg:row-start-1">Incoming</Label>
        <div className="min-w-0 lg:col-start-1 lg:row-start-2 mb-4 lg:mb-0"><Stack sel={sel} onPick={pick} /></div>
        <Label className="lg:col-start-2 lg:row-start-1">Four rules, first match decides</Label>
        <div className="min-w-0 lg:col-start-2 lg:row-start-2 mb-4 lg:mb-0"><Sieve it={it} s={s} run={run} acc={acc} still={still} /></div>
        <Label className="lg:col-start-3 lg:row-start-1">Lands on</Label>
        <Destination it={it} done={s >= it.decide + 2} run={run} picked={picked} onPick={setPicked} acc={acc} />
      </div>

      <div className="mt-10 max-w-3xl">
        <ForScripts note={<><C>POST /cli/route</C> takes the same call from a webhook, an inbound email or a form, with an API token.</>}>
          <div className="rounded-lg px-4 py-3 font-mono text-[12.5px] leading-[1.7] overflow-x-auto" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
            <div className="whitespace-nowrap"><span style={{ color: SOL.base01 }}>$ </span>{cmd}</div>
            <div className="whitespace-nowrap" style={{ color: SOL.base1 }}>{outputLine(it, picked)}</div>
          </div>
        </ForScripts>
      </div>
    </Section>
  );
}

function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`font-mono text-[12px] font-semibold ${className}`} style={{ color: MUTED }}>{children}</div>;
}

function outputLine(it: Item, picked: string | null): string {
  if (picked) return `→ ${role(picked).handle} · line 1: named ${role(picked).handle}`;
  if (!it.owner) {
    const r = it.read!;
    return `Nobody yet · line 4: ${it.why} (${Math.round(r.top.c * 100)}% sure)`;
  }
  const who = "role" in it.owner ? role(it.owner.role).handle : person(it.owner.person).handle;
  const sure = it.read ? ` (${Math.round(it.read.top.c * 100)}% sure)` : "";
  return `→ ${who} · line ${it.decide}: ${it.why}${sure}`;
}

// ---- Left: the incoming stack ----------------------------------------------

function Stack({ sel, onPick }: { sel: string; onPick: (id: string) => void }) {
  return (
    <div>
      <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0 -mx-1 px-1">
        {ITEMS.map((x) => {
          const on = x.id === sel;
          return (
            <button
              key={x.id}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(x.id)}
              className="og-press og-routing-item shrink-0 w-[220px] lg:w-auto text-left rounded-xl border px-3 py-2.5"
              style={{
                borderColor: on ? INK : LINE,
                backgroundColor: on ? "#fffdf6" : tint(SAND, 60),
                boxShadow: on ? "0 12px 26px -18px rgba(0,43,54,.55)" : "none",
                transform: on ? "translateX(4px)" : undefined,
              }}
            >
              <div className="font-mono text-meta truncate" style={{ color: on ? MUTED : DIM }}>{x.source}</div>
              <div className="mt-1 text-[13px] leading-[1.4] line-clamp-2" style={{ color: on ? INK : TEXT }}>{x.text}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Center: the four lines as a sieve --------------------------------------

function Sieve({ it, s, run, acc, still }: { it: Item; s: number; run: number; acc: string; still: boolean }) {
  const landed = s > it.decide;
  const row = s === 0 ? 0 : Math.min(s, it.decide) - 1;
  const puckTop = s === 0 ? "-10px" : `calc(${row} * ${ROW_H} + ${GATE_Y + 24 - PUCK}px)`;
  const puckColor = landed ? acc : SOL.base01;
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 30px 70px -40px rgba(0,43,54,.45)" }}>
      <div key={`h-${run}`} className="og-anim og-pop px-4 py-3 border-b flex items-center gap-2.5" style={{ borderColor: LINE, backgroundColor: tint(SOL.base2, 50) }}>
        <span className="font-mono text-meta shrink-0 rounded px-1.5 py-0.5" style={{ backgroundColor: PAPER, color: MUTED, border: `1px solid ${LINE}` }}>new</span>
        <span className="text-[13px] truncate" style={{ color: INK }}>{it.text}</span>
      </div>

      <div className="relative pt-6">
        {/* the chute's walls */}
        <div aria-hidden className="absolute top-0 bottom-0 left-[14px] w-[24px] border-x" style={{ borderColor: LINE, backgroundColor: tint(SOL.base2, 45, "transparent") }} />
        {/* the path the item has fallen so far */}
        <div
          aria-hidden
          className="og-routing-trail absolute left-[25px] top-0 w-[2px] rounded-full z-[5]"
          style={{ height: s === 0 ? 0 : `calc(${puckTop} + ${PUCK / 2}px)`, backgroundColor: puckColor, transitionDuration: still ? "0s" : undefined }}
        />
        <div
          aria-hidden
          className="og-routing-puck absolute left-[18px] z-10"
          style={{ top: puckTop, width: PUCK, height: PUCK, transitionDuration: still ? "0s" : undefined }}
        >
          <span
            key={landed ? `land-${run}` : `fall-${run}`}
            className={`block w-full h-full rounded-full ${landed && run > 0 ? "og-routing-squash" : ""}`}
            style={{ backgroundColor: puckColor, boxShadow: `0 0 0 3px ${tint(puckColor, 22, "transparent")}, 0 4px 10px -2px ${tint(puckColor, 60, "transparent")}` }}
          />
        </div>

        {LINES.map((l) => (
          <Row key={l.n} n={l.n} name={l.name} rule={l.rule} state={rowState(l.n, it.decide, s)} note={it.notes[l.n - 1]} acc={acc} unsure={!it.owner}>
            {l.n === 4 && it.read && s > 4 && <RouterRead read={it.read} run={run} />}
          </Row>
        ))}
      </div>
    </div>
  );
}

const VERDICT: Record<RowState, string> = { idle: "", testing: "testing", skip: "no match", decides: "decides", unreached: "not reached" };

function Row({ n, name, rule, state, note, acc, unsure, children }: {
  n: Line; name: string; rule: string; state: RowState; note?: string; acc: string; unsure: boolean; children?: ReactNode;
}) {
  const lit = state === "decides";
  const testing = state === "testing";
  const c = lit ? (unsure ? SOL.yellow : acc) : testing ? SOL.base01 : DIM;
  const shown = state === "skip" || state === "decides" || state === "testing";
  return (
    <div
      className="og-routing-row relative grid grid-cols-[52px_minmax(0,1fr)] border-t"
      data-state={state}
      style={{ borderColor: LINE, backgroundColor: lit ? tint(c, 9, "#fffdf6") : testing ? tint(SOL.base2, 70, "#fffdf6") : "transparent", ["--og-c" as string]: c } as CSSProperties}
    >
      {/* the gate across the chute */}
      <span
        aria-hidden
        className="og-routing-gate absolute left-[14px] w-[24px] h-[3px] rounded-full"
        style={{ top: GATE_Y, backgroundColor: lit ? c : testing ? SOL.base01 : tint(SOL.base1, 70), transform: state === "skip" ? "rotate(78deg)" : "none", opacity: state === "skip" ? 0 : 1 }}
      />
      {/* a passed-through line keeps a hollow dot where its gate opened */}
      <span
        aria-hidden
        className="og-routing-mark absolute left-[19px] w-[14px] h-[14px] rounded-full z-20"
        style={{ top: GATE_Y - 12, backgroundColor: "#fffdf6", boxShadow: `inset 0 0 0 2px ${SOL.base1}`, opacity: state === "skip" ? 1 : 0, transform: state === "skip" ? "scale(1)" : "scale(.4)" }}
      />
      <div />
      <div className="pr-4 py-3" style={{ height: n < 4 ? ROW_H : undefined }}>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center rounded-full font-mono text-meta font-bold w-[20px] h-[20px] shrink-0" style={{ backgroundColor: lit ? c : "transparent", color: lit ? PAPER : MUTED, boxShadow: lit ? "none" : `inset 0 0 0 1.5px ${LINE}`, transition: "background-color .3s ease, color .3s ease" }}>{n}</span>
          <span className="font-mono font-bold text-[14px]" style={{ color: INK }}>{name}</span>
          {VERDICT[state] && (
            <span
              key={state}
              className="og-anim og-fade ml-auto font-mono text-meta rounded-full px-2 py-0.5 shrink-0"
              style={lit ? { backgroundColor: c, color: PAPER } : { color: testing ? TEXT : DIM, border: `1px solid ${LINE}`, opacity: testing ? 1 : 0.75 }}
            >
              {lit && unsure ? "unsure" : VERDICT[state]}
            </span>
          )}
        </div>
        <div className="mt-1 text-[12.5px] leading-[1.45] line-clamp-2" style={{ color: MUTED }}>{rule}</div>
        {shown && note && (
          <div key={`${note}-${state === "testing"}`} className="og-anim og-fade mt-1 font-mono text-meta truncate" style={{ color: lit ? `color-mix(in srgb, ${c} 70%, ${INK})` : DIM }}>
            {state === "skip" ? "✕ " : lit ? "✓ " : ""}{note}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function RouterRead({ read, run }: { read: Read; run: number }) {
  const lead = read.top.c - read.second.c;
  const sure = read.top.c >= CONFIDENT && lead >= MARGIN;
  return (
    <div key={run} className="og-anim og-rise mt-3 rounded-lg border px-3 py-2.5" style={{ borderColor: LINE, backgroundColor: PAPER }}>
      {[read.top, read.second].map((x, i) => {
        const r = role(x.id);
        const a = accentOf(r.k);
        return (
          <div key={x.id} className="flex items-center gap-2 py-1">
            <Tile k={r.k} size={18} />
            <span className="font-mono text-meta w-[64px] sm:w-[92px] shrink-0 truncate" style={{ color: i === 0 ? INK : MUTED }}>{r.handle}</span>
            <span className="relative flex-1 min-w-[72px] h-[8px] rounded-full" style={{ backgroundColor: tint(SOL.base1, 22) }}>
              <span className="og-routing-bar absolute inset-y-0 left-0 rounded-full" style={{ width: `${x.c * 100}%`, backgroundColor: i === 0 ? a : tint(a, 55), animationDelay: `${0.1 + i * 0.12}s` }} />
              <span aria-hidden className="absolute -top-[3px] -bottom-[3px] w-0 border-l border-dashed" style={{ left: `${CONFIDENT * 100}%`, borderColor: INK }} />
            </span>
            <span className="font-mono text-meta font-semibold w-[34px] text-right tabular-nums" style={{ color: i === 0 ? INK : MUTED }}>{x.c.toFixed(2)}</span>
          </div>
        );
      })}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta" style={{ color: MUTED }}>
        <span>files at 0.8 or more with a 0.3 lead</span>
        <span className="ml-auto rounded px-1.5 py-0.5" style={{ backgroundColor: tint(sure ? SOL.green : SOL.yellow, 16), color: `color-mix(in srgb, ${sure ? SOL.green : SOL.yellow} 60%, ${INK})` }}>
          lead {lead.toFixed(2)} · {sure ? "files" : "files nothing"}
        </span>
      </div>
      {sure && <div className="mt-1.5 text-[12px] leading-[1.45]" style={{ color: BODY }}>“{read.reason}”</div>}
    </div>
  );
}

// ---- Right: where it landed -------------------------------------------------

function Destination({ it, done, run, picked, onPick, acc }: {
  it: Item; done: boolean; run: number; picked: string | null; onPick: (id: string) => void; acc: string;
}) {
  if (!done) {
    return (
      <div className="min-w-0 lg:col-start-3 lg:row-start-2 rounded-2xl border border-dashed min-h-[220px] flex items-center justify-center font-mono text-[12px]" style={{ borderColor: LINE, color: DIM }}>
        routing…
      </div>
    );
  }
  const roleId = picked ?? (it.owner && "role" in it.owner ? it.owner.role : null);
  return (
    <div key={`${it.id}-${run}-${picked ?? ""}`} className="min-w-0 lg:col-start-3 lg:row-start-2 og-anim og-routing-arrive rounded-2xl border p-4 flex flex-col" style={{ borderColor: tint(acc, 45), backgroundColor: "#fffdf6", boxShadow: `0 24px 50px -32px rgba(0,43,54,.5), 0 0 0 3px ${tint(acc, 14, "transparent")}` }}>
      {roleId ? <RoleLanding r={role(roleId)} it={it} picked={!!picked} />
        : it.owner && "person" in it.owner ? <PersonLanding id={it.owner.person} />
        : <Choose read={it.read!} onPick={onPick} />}
      <Trail it={it} acc={acc} picked={!!picked} />
    </div>
  );
}

/** The four lines as the item met them: ✕ passed through, ✓ decided, ? the router was unsure, – never reached. */
function Trail({ it, acc, picked }: { it: Item; acc: string; picked: boolean }) {
  const unsure = !it.owner;
  return (
    <div className="og-anim og-fade mt-auto pt-4 flex flex-wrap items-center gap-1.5" style={{ ["--d" as string]: "0.45s" } as CSSProperties}>
      {LINES.map((l) => {
        const mark = l.n < it.decide ? "✕" : l.n > it.decide ? "–" : unsure ? "?" : "✓";
        const on = l.n === it.decide;
        const c = unsure ? SOL.yellow : acc;
        return (
          <span
            key={l.n}
            title={l.name}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-meta"
            style={on ? { backgroundColor: tint(c, 18, PAPER), color: `color-mix(in srgb, ${c} 60%, ${INK})`, boxShadow: `inset 0 0 0 1px ${tint(c, 50, PAPER)}` } : { color: DIM, boxShadow: `inset 0 0 0 1px ${LINE}` }}
          >
            <span className="font-bold">{l.n}</span>{mark}
          </span>
        );
      })}
      {picked && <span className="ml-1 font-mono text-meta" style={{ color: DIM }}>then you picked</span>}
    </div>
  );
}

function Head({ face, title, handle, sub }: { face: ReactNode; title: string; handle: string; sub: string }) {
  return (
    <div className="flex items-center gap-3">
      {face}
      <div className="min-w-0">
        <div className="font-mono font-bold text-[14px] leading-tight truncate" style={{ color: INK }}>{title}</div>
        <div className="font-mono text-meta" style={{ color: DIM }}>{handle}</div>
        <div className="text-[12px] truncate" style={{ color: MUTED }}>{sub}</div>
      </div>
    </div>
  );
}

function Fact({ label, children, t }: { label: string; children: ReactNode; t: number }) {
  return (
    <div className="og-anim og-rise flex items-baseline gap-3 py-1.5 border-t" style={{ borderColor: LINE, ["--d" as string]: `${t}s` } as CSSProperties}>
      <span className="font-mono text-meta w-[64px] shrink-0" style={{ color: DIM }}>{label}</span>
      <span className="text-[12.5px] leading-[1.45] min-w-0" style={{ color: TEXT }}>{children}</span>
    </div>
  );
}

function RoleLanding({ r, it, picked }: { r: RoleRow; it: Item; picked: boolean }) {
  return (
    <>
      <Head face={<Tile k={r.k} size={44} ring />} title={r.title} handle={r.handle} sub={r.area} />
      <div className="mt-4">
        <Fact label="task" t={0.12}><span className="font-mono text-meta" style={{ color: MUTED }}>{it.task!.id}</span> {it.task!.title}</Fact>
        <Fact label="filed" t={0.2}>In its area, assigned to {r.handle}</Fact>
        <Fact label="role" t={0.28}><span className="inline-flex items-center gap-1.5"><SessionDot state="working" /> Woken with one line naming the task</span></Fact>
        <Fact label="decided" t={0.36}>
          <span className="font-mono text-meta">line {picked ? 1 : it.decide}</span>{" "}
          <span style={{ color: MUTED }}>{picked ? `you picked ${r.handle}` : it.why}</span>
        </Fact>
      </div>
    </>
  );
}

function PersonLanding({ id }: { id: string }) {
  const p = person(id);
  return (
    <>
      <Head face={<Person p={p} size={44} />} title={p.name} handle={p.handle} sub="Started it on their laptop" />
      <div className="mt-4">
        <Fact label="session" t={0.12}>Stays in {p.name.split(" ")[0]}'s list</Fact>
        <Fact label="role" t={0.2}>None woken</Fact>
        <Fact label="later" t={0.28}>Moves under a role once bound to a task in its area</Fact>
        <Fact label="decided" t={0.36}><span className="font-mono text-meta">line 3</span> <span style={{ color: MUTED }}>no task, plan or project</span></Fact>
      </div>
    </>
  );
}

function Choose({ read, onPick }: { read: Read; onPick: (id: string) => void }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="inline-block w-[10px] h-[10px] rounded-full" style={{ backgroundColor: SOL.yellow }} />
        <span className="font-mono font-bold text-[14px]" style={{ color: INK }}>Not filed</span>
        <span className="ml-auto font-mono text-meta" style={{ color: DIM }}>pick who takes it</span>
      </div>
      <div className="mt-3 space-y-2">
        {[read.top, read.second].map((x, i) => {
          const r = role(x.id);
          return (
            <button
              key={x.id}
              type="button"
              onClick={() => onPick(x.id)}
              className="og-press og-lift og-anim og-rise w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left"
              style={{ borderColor: LINE, backgroundColor: PAPER, ["--d" as string]: `${0.1 + i * 0.08}s` } as CSSProperties}
            >
              <Tile k={r.k} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block font-mono font-semibold text-[12.5px] truncate" style={{ color: INK }}>{r.title}</span>
                <span className="block font-mono text-meta" style={{ color: DIM }}>{r.handle}</span>
              </span>
              <span className="font-mono text-[12px] font-semibold tabular-nums" style={{ color: MUTED }}>{x.c.toFixed(2)}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 font-mono text-meta" style={{ color: DIM }}>{read.reason}</div>
    </>
  );
}

const CSS = `
.og-root { --og-routing-row: 108px; }
@media (min-width: 640px) { .og-root { --og-routing-row: 88px; } }
.og-routing-puck { transition: top .5s cubic-bezier(.5,0,.4,1.35); will-change: top; }
.og-routing-squash { animation: og-routing-squash .42s cubic-bezier(.3,1.5,.5,1) both; transform-origin: 50% 100%; }
@keyframes og-routing-squash {
  0% { transform: scale(1.18, .7); }
  45% { transform: scale(.92, 1.1); }
  100% { transform: none; }
}
.og-routing-trail { transition: height .5s cubic-bezier(.5,0,.4,1.35), background-color .3s ease; }
.og-routing-mark { transition: opacity .25s ease .15s, transform .35s cubic-bezier(.3,1.6,.5,1) .15s; }
.og-routing-gate { transform-origin: 0 50%; transition: transform .38s cubic-bezier(.3,1.5,.5,1), background-color .3s ease; }
.og-routing-row { transition: background-color .35s ease; }
.og-routing-row[data-state="testing"]::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--og-c);
}
.og-routing-row[data-state="decides"]::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--og-c);
  animation: og-fade .3s ease both;
}
.og-routing-item { transition: transform .3s cubic-bezier(.3,1.4,.5,1), box-shadow .25s ease, border-color .2s ease, background-color .2s ease; }
.og-routing-bar { transform-origin: 0 50%; animation: og-routing-grow .7s cubic-bezier(.2,.75,.2,1) both; }
@keyframes og-routing-grow { from { transform: scaleX(0); } to { transform: none; } }
.og-routing-arrive { animation-name: og-routing-arrive; animation-duration: .55s; animation-timing-function: cubic-bezier(.3,1.35,.5,1); }
@keyframes og-routing-arrive { from { opacity: 0; transform: translateX(-18px) scale(.94); } to { opacity: 1; transform: none; } }
.og-root[data-static] .og-routing-squash, .og-root[data-static] .og-routing-bar, .og-root[data-static] .og-routing-arrive { animation: none !important; }
.og-root[data-static] .og-routing-puck, .og-root[data-static] .og-routing-gate, .og-root[data-static] .og-routing-trail, .og-root[data-static] .og-routing-mark { transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  .og-routing-squash, .og-routing-bar, .og-routing-arrive { animation: none !important; }
  .og-routing-puck, .og-routing-gate, .og-routing-trail, .og-routing-mark, .og-routing-row, .og-routing-item { transition: none !important; }
}
`;
