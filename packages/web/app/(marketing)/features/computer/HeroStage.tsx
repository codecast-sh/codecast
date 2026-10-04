"use client";

import { useRef, useState } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";
import { HERO_STEPS, HERO_TERM, HUMAN_NOTE } from "./data";
import { AgentCursorGlyph, HumanCursorGlyph, Lights, Term, TermLineView, useStillMode } from "./parts";

/**
 * The hero: one Mac desktop, two people at work. The human writes in Notes,
 * the frontmost window. Behind it an agent signs a PDF in Preview through
 * cast computer: the window splits into the tree the agent reads, the orange
 * agent cursor glides and pulses, and every change the terminal prints is
 * outlined on the window where it happened.
 *
 * The stage is laid out in em on a 96 x 60 grid; its font size is 1/96 of the
 * container width, so the whole desktop scales as one picture.
 */

const LAST = HERO_STEPS.length - 1;

/** Where the agent cursor's tip sits at each step, in stage em. */
const CURSOR_AT = [
  { x: 30, y: 30 },
  { x: 33, y: 24 },
  { x: 51.2, y: 7.4 },
  { x: 45.5, y: 13.6 },
  { x: 36, y: 50 },
];

export function HeroStage() {
  const still = useStillMode();
  const [step, setStep] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [typed, setTyped] = useState(0);
  const termRef = useRef<HTMLDivElement>(null);

  const s = still ? LAST : step;

  // The agent's steps.
  useWatchEffect(() => {
    if (still || !playing) return;
    const t = setTimeout(() => {
      if (step === LAST) {
        setStep(0);
        setCycle((c) => c + 1);
      } else setStep(step + 1);
    }, HERO_STEPS[step].ms);
    return () => clearTimeout(t);
  }, [step, playing, still]);

  // The human's typing: its own clock, because the human never waits on the agent.
  useWatchEffect(() => {
    if (still) return;
    const done = typed >= HUMAN_NOTE.length;
    const t = setTimeout(() => setTyped(done ? 15 : typed + 1), done ? 2600 : HUMAN_NOTE[typed] === "\n" ? 420 : 75 + ((typed * 37) % 60));
    return () => clearTimeout(t);
  }, [typed, still]);

  // Keep the newest terminal line in view.
  useWatchEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
  }, [s, still]);

  const note = still ? HUMAN_NOTE : HUMAN_NOTE.slice(0, typed);
  const cur = CURSOR_AT[s];
  const pressing = s === 2 || s === 3;

  return (
    <div className="grid-cols-1 cx-hero-grid grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px] items-start">
      <div>
        <div className="cx-stage-wrap rounded-[14px] overflow-hidden" style={{ boxShadow: "0 40px 90px -40px rgba(0,43,54,0.6), 0 0 0 1px rgba(0,43,54,0.12)" }}>
          <div className={`cx-stage relative select-none ${still ? "cx-still" : ""}`} role="img" aria-label="A Mac desktop: the human types a note in Notes while, in the Preview window behind it, an agent clicks Sign and inserts a saved signature. The orange agent cursor moves without touching the human's pointer.">
            <Wallpaper />
            <MenuBar />
            <PreviewWindow step={s} />
            <NotesWindow note={note} />
            {/* The agent cursor: glides between targets, pulses when it presses. */}
            <div
              className="cx-agent-cursor absolute z-30"
              style={{ left: 0, top: 0, transform: `translate(${cur.x}em, ${cur.y}em)`, opacity: s === 0 ? 0 : 1 }}
            >
              {pressing && <span key={`${cycle}-${s}`} className="cx-pulse absolute rounded-full" style={{ left: "-1.3em", top: "-1.3em", width: "2.8em", height: "2.8em" }} />}
              <AgentCursorGlyph size={1.05} />
            </div>
          </div>
        </div>
        <Scrubber step={s} cycle={cycle} playing={playing && !still} still={still} onPick={(i) => { setStep(i); setPlaying(false); }} onPlay={() => { setPlaying(true); if (step === LAST) setStep(0); }} />
      </div>

      <div className="flex flex-col gap-3 lg:sticky lg:top-24">
        <Term label="claude · ~/leases" bodyClassName="cx-hero-term">
          <div ref={termRef} className="h-[230px] sm:h-[340px] overflow-y-auto overflow-x-hidden pr-1 cx-scroll">
            {/* Only lines already printed take space, so the newest stays in view; each step's lines arrive one after another. */}
            {HERO_TERM.map((l, i) => l.step > s ? null : (
              <TermLineView key={`${l.step === s ? cycle : "p"}-${i}`} line={l} className={l.step === s && !still ? "cx-line-in" : ""} style={{ animationDelay: `${(i - HERO_TERM.findIndex((x) => x.step === s)) * 140}ms` }} />
            ))}
            <div className="cx-tl" style={{ color: SOL.green }}>$ <span className="cx-caret" /></div>
          </div>
        </Term>
        <div className={`cx-reveal ${s === LAST ? "is-on" : ""} rounded-xl px-4 py-3 text-[14px] leading-relaxed`} style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}`, color: SOL.base01, transitionDelay: s === LAST && !still ? "300ms" : "0ms" }}>
          <span className="font-mono text-[12px] mr-2" style={{ color: SOL.blue }}>claude</span>
          Signed the lease on page 2 with your saved signature. I did not save or send it; that part is yours.
        </div>
      </div>
    </div>
  );
}

function Scrubber({ step, cycle, playing, still, onPick, onPlay }: { step: number; cycle: number; playing: boolean; still: boolean; onPick: (i: number) => void; onPlay: () => void }) {
  return (
    <div className="mt-4 flex items-center gap-2 font-mono text-[12px]">
      <button type="button" onClick={onPlay} disabled={playing || still} className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-opacity disabled:opacity-35" style={{ backgroundColor: SOL.base2, color: SOL.base02 }} aria-label="Play">
        <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" fill="currentColor" aria-hidden><path d="M2 1.2v7.6a.6.6 0 0 0 .9.5l6.1-3.8a.6.6 0 0 0 0-1L2.9.7a.6.6 0 0 0-.9.5z" /></svg>
      </button>
      <div className="flex-1 grid grid-cols-4 gap-1.5">
        {HERO_STEPS.slice(1).map((st, j) => {
          const i = j + 1;
          const on = step >= i;
          const now = step === i;
          return (
            <button key={st.key} type="button" onClick={() => onPick(i)} className="text-left group" aria-label={`Show step ${i}: ${st.label}`}>
              <span className="block h-[3px] rounded-full overflow-hidden" style={{ backgroundColor: "rgba(0,43,54,0.1)" }}>
                <span
                  key={now ? `${cycle}-${i}-${playing}` : "x"}
                  className={`block h-full rounded-full ${now && playing ? "cx-fill" : ""}`}
                  style={{ backgroundColor: SOL.magenta, width: on && !(now && playing) ? "100%" : now && playing ? undefined : "0%", animationDuration: `${st.ms}ms` }}
                />
              </span>
              <span className="mt-1.5 block truncate transition-colors" style={{ color: now ? SOL.base03 : SOL.base1 }}>
                <span className="hidden sm:inline">{i}. </span>{st.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Wallpaper() {
  return (
    <div className="absolute inset-0" aria-hidden style={{
      background: `radial-gradient(60em 40em at 12% 18%, rgba(42,161,152,0.55), transparent 60%),
        radial-gradient(50em 40em at 88% 90%, rgba(211,54,130,0.42), transparent 62%),
        radial-gradient(40em 30em at 80% 10%, rgba(38,139,210,0.45), transparent 60%),
        linear-gradient(160deg, #0a4a5a 0%, #12384a 55%, #2b2148 100%)`,
    }} />
  );
}

function MenuBar() {
  return (
    <div className="absolute left-0 right-0 top-0 z-20 flex items-center gap-[1.6em] px-[1.6em] font-sans text-[1.15em]" style={{ height: "2.1em", backgroundColor: "rgba(253,246,227,0.72)", backdropFilter: "blur(1em)", color: "#1d2a30" }}>
      <svg viewBox="0 0 14 16" className="w-[0.95em] h-[1.1em]" fill="currentColor" aria-hidden><circle cx="7" cy="9" r="6" /></svg>
      <span className="font-semibold">Notes</span>
      <span className="hidden sm:inline opacity-80">File</span>
      <span className="hidden sm:inline opacity-80">Edit</span>
      <span className="hidden sm:inline opacity-80">Format</span>
      <span className="hidden sm:inline opacity-80">View</span>
      <span className="ml-auto opacity-80">Sun 9:41 AM</span>
    </div>
  );
}

/** An outline the agent's view draws on the window: index, role, name. */
function Mark({ x, y, w, h, label, kind, on, below = false }: { x: number; y: number; w: number; h: number; label: string; kind: "seen" | "add" | "rem"; on: boolean; below?: boolean }) {
  const col = kind === "add" ? SOL.green : kind === "rem" ? SOL.red : SOL.magenta;
  return (
    <div className={`cx-mark absolute pointer-events-none ${on ? "is-on" : ""}`} style={{ left: `${x}em`, top: `${y}em`, width: `${w}em`, height: `${h}em`, border: `0.14em dashed ${col}`, borderRadius: "0.5em", backgroundColor: `color-mix(in srgb, ${col} 8%, transparent)` }}>
      <span className="absolute whitespace-nowrap font-mono rounded-[0.3em] px-[0.5em] py-[0.15em] text-[1.05em]" style={{ left: "-0.14em", ...(below ? { top: "calc(100% + 0.35em)" } : { bottom: "calc(100% + 0.35em)" }), backgroundColor: col, color: "#fff" }}>
        {label}
      </span>
    </div>
  );
}

function PreviewWindow({ step }: { step: number }) {
  const popover = step === 2;
  const signed = step >= 3;
  return (
    <div className="absolute z-10 rounded-[1em] overflow-hidden" style={{ left: "3em", top: "4.6em", width: "58em", height: "53em", backgroundColor: "#ece7da", boxShadow: "0 1.6em 3.6em -1em rgba(0,0,0,0.45), 0 0 0 0.08em rgba(0,0,0,0.18)" }}>
      {/* Unified toolbar */}
      <div className="relative flex items-center gap-[1.2em] px-[1.3em] font-sans" style={{ height: "4.4em", backgroundColor: "#e6e0d1", borderBottom: "0.08em solid rgba(0,0,0,0.1)" }}>
        <Lights active={false} />
        <div className="leading-tight ml-[0.6em]">
          <div className="text-[1.25em] font-semibold" style={{ color: "#7a7468" }}>Lease renewal.pdf</div>
          <div className="text-[1em]" style={{ color: "#9a9486" }}>Page 2 of 3</div>
        </div>
        <div className="ml-auto flex items-center gap-[0.9em]" style={{ color: "#8b8577" }}>
          {["M3 8h10M3 4h10M3 12h10", "M4 4l8 8M12 4l-8 8", "M8 3v10M3 8h10"].map((d, i) => (
            <span key={i} className="w-[3em] h-[2.6em] rounded-[0.5em] flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.04)" }}>
              <svg viewBox="0 0 16 16" className="w-[1.3em] h-[1.3em]" fill="none" stroke="currentColor" strokeWidth="1.4"><path d={d} /></svg>
            </span>
          ))}
          {/* Sign */}
          <span className="w-[4.4em] h-[2.6em] rounded-[0.5em] flex items-center justify-center gap-[0.3em] transition-colors" style={{ backgroundColor: popover ? "rgba(0,0,0,0.14)" : "rgba(0,0,0,0.04)" }}>
            <svg viewBox="0 0 16 16" className="w-[1.4em] h-[1.4em]" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 12c2-1 3-5 5-5s0 5 2 5 2-3 3-3 1 2 2 2" /></svg>
            <svg viewBox="0 0 10 10" className="w-[0.7em] h-[0.7em]" fill="currentColor"><path d="M1 3l4 4 4-4z" /></svg>
          </span>
          <span className="w-[3em] h-[2.6em] rounded-[0.5em] flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.04)" }}>
            <svg viewBox="0 0 16 16" className="w-[1.3em] h-[1.3em]" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></svg>
          </span>
        </div>
      </div>

      {/* The page */}
      <div className="absolute font-serif" style={{ left: "8em", top: "6.4em", width: "40em", height: "52em", backgroundColor: "#fffefb", boxShadow: "0 0.3em 1.2em rgba(0,0,0,0.18)", padding: "3em 3.6em", color: "#2a2a2a" }}>
        <div className="text-[1.9em] font-semibold tracking-tight">Lease renewal</div>
        <div className="mt-[0.4em] text-[1.05em]" style={{ color: "#8a8a8a" }}>Unit 4B · term Nov 1, 2026 to Oct 31, 2027</div>
        <div className="mt-[2em] space-y-[0.9em]">
          {[96, 88, 92, 70, 0, 94, 90, 84, 60].map((w, i) => (
            <div key={i} className="h-[0.75em] rounded-full" style={{ width: `${w}%`, backgroundColor: w ? "#e6e3dc" : "transparent" }} />
          ))}
        </div>
        <div className="absolute" style={{ left: "3.6em", right: "3.6em", top: "33em" }}>
          <div className="relative h-[5em]">
            <svg viewBox="0 0 200 50" className={`cx-sig absolute ${signed ? "is-on" : ""}`} style={{ left: "1em", bottom: "0.4em", width: "15em", height: "4em" }} aria-hidden>
              <path d="M6 36 C 18 8, 26 8, 24 30 S 40 44, 52 20 S 62 6, 64 28 S 80 40, 92 22 C 100 12, 108 14, 110 26 S 126 36, 140 18 S 160 30, 196 22" fill="none" stroke="#1f3b8f" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
          <div className="h-[0.12em]" style={{ backgroundColor: "#bdb8ad", width: "60%" }} />
          <div className="mt-[0.5em] text-[1em]" style={{ color: "#8a8a8a" }}>Tenant signature</div>
        </div>
      </div>

      {/* The Sign popover */}
      <div className={`cx-popover absolute rounded-[0.9em] font-sans ${popover ? "is-on" : ""}`} style={{ left: "34.4em", top: "4.2em", width: "17em", padding: "0.7em", backgroundColor: "rgba(250,248,242,0.97)", boxShadow: "0 1em 2.6em -0.6em rgba(0,0,0,0.4), 0 0 0 0.08em rgba(0,0,0,0.12)" }}>
        <div className="rounded-[0.6em] px-[0.9em] py-[0.7em]" style={{ backgroundColor: step === 2 ? "rgba(38,139,210,0.12)" : "transparent" }}>
          <svg viewBox="0 0 200 50" className="w-[11em] h-[2.6em]" aria-hidden><path d="M6 36 C 18 8, 26 8, 24 30 S 40 44, 52 20 S 62 6, 64 28 S 80 40, 92 22 C 100 12, 108 14, 110 26 S 126 36, 140 18 S 160 30, 196 22" fill="none" stroke="#1f3b8f" strokeWidth="3" strokeLinecap="round" /></svg>
          <div className="text-[1em]" style={{ color: "#6f6a60" }}>Created January 27</div>
        </div>
        <div className="mt-[0.4em] pt-[0.6em] px-[0.9em] text-[1.1em]" style={{ borderTop: "0.08em solid rgba(0,0,0,0.1)", color: "#3a3a3a" }}>Create Signature…</div>
      </div>

      {/* The agent's view: what it read, and what each action changed */}
      <Mark x={0.5} y={0.5} w={57} h={52} label="0 standard window Lease renewal.pdf" kind="seen" on={step === 1} below />
      <Mark x={45.6} y={0.8} w={5.2} h={3.1} label="41 button Sign" kind="seen" on={step === 1} below />
      <Mark x={34.2} y={4} w={17.4} h={13.2} label="+ 88 popover" kind="add" on={step === 2} below />
      <Mark x={11} y={36.6} w={19} h={7} label="+ 92 image Signature" kind="add" on={step >= 3} />

      {/* The scan: a band that sweeps the window while the agent reads it */}
      {step === 1 && <div className="cx-scan absolute left-0 right-0 pointer-events-none" style={{ height: "6em" }} />}
    </div>
  );
}

function NotesWindow({ note }: { note: string }) {
  const [title, ...rest] = note.split("\n");
  return (
    <div className="absolute z-20 rounded-[1em] overflow-hidden font-sans" style={{ left: "55.5em", top: "15em", width: "37.5em", height: "40em", backgroundColor: "#fffdf6", boxShadow: "0 2.6em 5em -1.2em rgba(0,0,0,0.6), 0 0 0 0.08em rgba(0,0,0,0.2)" }}>
      <div className="flex items-center gap-[1em] px-[1.3em]" style={{ height: "3.6em", backgroundColor: "#f6f1e3", borderBottom: "0.08em solid rgba(0,0,0,0.08)" }}>
        <Lights active />
        <span className="ml-auto text-[1.05em]" style={{ color: "#a39d8f" }}>Edited just now</span>
      </div>
      <div className="px-[2.2em] pt-[1.8em] text-[1.5em] leading-[1.55]" style={{ color: "#2a2a2a" }}>
        <div className="font-bold text-[1.3em]">{title}<Caret show={rest.length === 0} /></div>
        {rest.map((line, i) => (
          <div key={i}>{line}{i === rest.length - 1 && <Caret show />}</div>
        ))}
      </div>
      {/* The human's pointer: parked where they left it, the whole time. */}
      <div className="absolute flex items-start gap-[0.4em]" style={{ left: "17em", top: "27em" }}>
        <HumanCursorGlyph />
        <span className="mt-[1.6em] rounded-[0.35em] px-[0.5em] py-[0.1em] text-[1em] font-semibold whitespace-nowrap" style={{ backgroundColor: SOL.blue, color: "#fff" }}>you, still typing</span>
      </div>
    </div>
  );
}

function Caret({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="cx-caret-note inline-block align-[-0.12em] ml-[0.05em]" style={{ width: "0.08em", height: "1.05em", backgroundColor: "#e0a100" }} />;
}
