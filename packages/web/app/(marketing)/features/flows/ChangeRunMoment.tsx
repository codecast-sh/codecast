"use client";

import { type CSSProperties, type ReactNode } from "react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { SOL } from "../../blog/blogChrome";
import { BACK, BAD, DIM, FLOOR, GOOD, HAIR, INK, LINE, MUTED, PERSON, TEXT, tint } from "./base";
import { CHANGE, LIVE_LINE, PROBLEM } from "./story";
import { AUTO_SHIP_MS, type Answer, type Beat, type Kind } from "./changeRunModel";

// The moment panel beside the Change run: what the step the token is on is
// doing right now, its terminal, notes and Decide's buttons.

export function Icon({ kind, x, y, color }: { kind: Kind; x: number; y: number; color: string }) {
  const p = { fill: "none", stroke: color, strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "shell") {
    return (
      <g {...p}>
        <rect x={x} y={y + 1} width={14} height={12} rx={2.5} />
        <path d={`M${x + 3.5} ${y + 5} l2.5 2 -2.5 2`} />
        <path d={`M${x + 7.5} ${y + 9.5} h3.5`} />
      </g>
    );
  }
  if (kind === "agent") {
    return (
      <g {...p}>
        <rect x={x} y={y + 3} width={14} height={10.5} rx={3} />
        <path d={`M${x + 7} ${y + 3} V${y + 0.5}`} />
        <circle cx={x + 4.8} cy={y + 8.2} r={0.9} fill={color} stroke="none" />
        <circle cx={x + 9.2} cy={y + 8.2} r={0.9} fill={color} stroke="none" />
      </g>
    );
  }
  if (kind === "person") {
    return (
      <g {...p}>
        <circle cx={x + 7} cy={y + 4.5} r={3.2} />
        <path d={`M${x + 1.5} ${y + 14} a5.5 5 0 0 1 11 0`} />
      </g>
    );
  }
  return null;
}
// ---------- The moment panel ----------

export function Chiplet({ color, children, dashed = false, solid = false }: { color: string; children: ReactNode; dashed?: boolean; solid?: boolean }) {
  return (
    <span className="inline-flex items-center h-[24px] px-2 rounded-md border font-mono text-[12.5px] whitespace-nowrap"
      style={{ color: solid ? SOL.base3 : color, borderColor: solid ? color : tint(color, 45), backgroundColor: solid ? color : tint(color, 9), borderStyle: dashed ? "dashed" : "solid" }}>
      {children}
    </span>
  );
}

export function PanelHead({ title, sub, icon, color = INK, right }: { title: string; sub?: ReactNode; icon?: Kind; color?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0">
      {icon && (
        <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0" aria-hidden><Icon kind={icon} x={1} y={1} color={color} /></svg>
      )}
      <span className="font-mono font-bold text-[15px]" style={{ color }}>{title}</span>
      {sub && <span className="font-mono text-[12.5px]" style={{ color: DIM }}>{sub}</span>}
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  );
}

function Terminal({ lines }: { lines: { t: string; c?: string }[] }) {
  return (
    <div className="mt-3 rounded-lg px-4 py-3 font-mono text-[12.5px] leading-[1.75] overflow-x-auto" style={{ backgroundColor: FLOOR }}>
      {lines.map((l, i) => (
        <div key={i} className="whitespace-pre" style={{ color: l.c ?? SOL.base1 }}>{l.t}</div>
      ))}
    </div>
  );
}

export function Visits({ label, n }: { label: string; n: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[12.5px]" style={{ color: BACK }}>
      <span className="font-semibold">{label}</span>
      <span className="flex gap-1" aria-label={`visit ${n} of 3`}>
        {[1, 2, 3].map((k) => (
          <span key={k} className="w-3.5 h-3.5 rounded-[4px] border" style={{ borderColor: tint(BACK, 55), backgroundColor: k <= n ? BACK : "transparent" }} />
        ))}
      </span>
      <span style={{ color: DIM }}>visit {n} of 3</span>
    </div>
  );
}

function Note({ who, color, children }: { who: string; color: string; children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border-l-[3px] px-3.5 py-2.5 text-[14px] leading-6" style={{ borderColor: color, backgroundColor: tint(color, 7), color: TEXT }}>
      <div className="font-mono text-[12px] mb-0.5" style={{ color }}>{who}</div>
      {children}
    </div>
  );
}

function Arrow({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 font-mono text-[12.5px]" style={{ color }}>
      <svg width={18} height={10} viewBox="0 0 18 10" className="shrink-0" aria-hidden><path d="M1 5 H15 M11 1.5 L15 5 L11 8.5" fill="none" stroke="currentColor" strokeWidth={1.4} /></svg>
      <span>{children}</span>
    </div>
  );
}

function Stats({ items }: { items: [string, ReactNode, string?][] }) {
  return (
    <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono">
      {items.map(([k, v, c]) => (
        <div key={k} className="rounded-md border px-2.5 py-2 min-w-0" style={{ borderColor: HAIR, backgroundColor: "#fffdf8" }}>
          <div className="text-meta" style={{ color: DIM }}>{k}</div>
          <div className="text-[14px] font-semibold tabular-nums" style={{ color: c ?? INK }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function SessionCard({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border px-3.5 py-3" style={{ borderColor: tint(PERSON, 40), backgroundColor: "#f1f5f4" }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12.5px]">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: PERSON }} />
        <span className="font-semibold" style={{ color: INK }}>Your session</span>
        <span style={{ color: DIM }}>{CHANGE.session}, where the change was made</span>
      </div>
      {children}
    </div>
  );
}

const CHECK_HEAD = [{ t: "$ bun run check" }, { t: "tsc        0 errors", c: SOL.base0 }, { t: "eslint     0 problems", c: SOL.base0 }, { t: "bun test" }];
const CHECK_FAIL = "total.test.ts › empty cart totals 0";
const CHECK_WHY = "TypeError: items[0] is undefined";
const REVIEW_ASK = "checkout.ts still reads items[0] when the cart is empty. Guard it there too.";

const TARGETS = ["web", "backend", "cli", "mobile", "desktop"] as const;
const touched = (t: string) => (CHANGE.targets as readonly string[]).includes(t);

/** The deploy targets on one line: the touched ones lit, the rest named and passed over. */
function Targets({ live }: { live: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-[12.5px]">
      {TARGETS.map((t) =>
        touched(t) ? (
          <span key={t} className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-md border" style={{ color: live ? SOL.base3 : "#1d7d76", borderColor: LINE, backgroundColor: live ? LINE : tint(LINE, 10) }}>
            {!live && <span className="flx-run-wait w-1.5 h-1.5 rounded-full" style={{ backgroundColor: LINE }} />}
            <b className="font-semibold">{t}</b>
            <span>{live ? CHANGE.deploys[t as keyof typeof CHANGE.deploys] : "waiting"}</span>
          </span>
        ) : (
          <span key={t} className="inline-flex items-center h-[26px] px-2 rounded-md border border-dashed line-through decoration-1" style={{ color: DIM, borderColor: HAIR }} title="no paths touched">{t}</span>
        ),
      )}
    </div>
  );
}

function DecideCard({ beat, onAnswer, paused, lap }: { beat: Beat; onAnswer?: (a: Answer) => void; paused: boolean; lap: number }) {
  const opts: [Answer, string, string, string][] = [
    ["S", "Ship", "Land the change", PERSON],
    ["R", "Revise", "Your note goes back to the session that made it", BACK],
    ["D", "Drop", "Leave the change unshipped", BAD],
  ];
  const live = !!beat.pending && !!onAnswer;
  return (
    <div className="mt-3 rounded-xl border overflow-hidden" style={{ borderColor: tint(PERSON, 45), backgroundColor: "#fbfcfb" }}>
      <div className="px-4 pt-3 pb-2.5 border-b" style={{ borderColor: tint(PERSON, 20) }}>
        <div className="font-mono font-semibold text-[14px]" style={{ color: INK }}>{PROBLEM.title}</div>
        <div className="font-mono text-[12.5px]" style={{ color: DIM }}>{CHANGE.subject}</div>
        <div className="text-[13.5px] mt-0.5" style={{ color: MUTED }}>It passed its checks and review.</div>
      </div>
      <div className="p-2 grid gap-1">
        {opts.map(([k, label, desc, c]) => {
          const on = beat.key === k;
          return (
            <button key={k} type="button" disabled={!live} onClick={() => onAnswer?.(k)}
              className={`flx-run-opt relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-left overflow-hidden ${on ? "flx-run-press" : ""}`}
              style={{ ["--oc" as string]: c, backgroundColor: on ? tint(c, 13) : undefined, boxShadow: on ? `inset 0 0 0 1.5px ${tint(c, 60)}` : undefined } as CSSProperties}>
              <KeyCap>{k}</KeyCap>
              <span className="font-mono font-semibold text-[13.5px] w-[56px] shrink-0" style={{ color: on ? c : INK }}>{label}</span>
              <span className="text-[13.5px] min-w-0" style={{ color: MUTED }}>{desc}</span>
              {live && k === "S" && (
                <span key={lap} className="flx-run-auto absolute left-0 bottom-0 h-[2px]" style={{ backgroundColor: PERSON, ["--ms" as string]: `${AUTO_SHIP_MS}ms`, animationPlayState: paused ? "paused" : "running" } as CSSProperties} aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Moment({ beats, beat, onAnswer, paused, lap }: { beats: Beat[]; beat: number; onAnswer: (a: Answer) => void; paused: boolean; lap: number }) {
  const b = beats[beat];
  const snapBefore = [...beats.slice(0, beat + 1)].reverse().find((x) => x.sha && x.sha !== CHANGE.landed)?.sha ?? CHANGE.frozen;
  switch (b.kind) {
    case "freeze":
      return (
        <>
          <PanelHead title="Your session" sub={CHANGE.session} color="#1f6fa8" right={<Chiplet color={MUTED}>{CHANGE.task}</Chiplet>} />
          <div className="mt-3 rounded-lg border font-mono text-[12.5px]" style={{ borderColor: HAIR, backgroundColor: "#fffdf8" }}>
            {CHANGE.files.map((f, i) => (
              <div key={f} className="flex items-center gap-3 px-3 h-8 border-b last:border-b-0" style={{ borderColor: HAIR }}>
                <span className="min-w-0 flex-1 break-all" style={{ color: TEXT }}>{f.replace(/^packages\//, "")}</span>
                <span style={{ color: GOOD }}>{i ? "+6" : "+14"}</span>
                <span className="w-6 text-right" style={{ color: BAD }}>{i ? "−1" : "−3"}</span>
              </div>
            ))}
          </div>
          <Arrow color={LINE}>frozen into a commit</Arrow>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chiplet color={LINE}>{CHANGE.frozen}</Chiplet>
            <Chiplet color={MUTED}>{CHANGE.branch}</Chiplet>
            <Chiplet color={MUTED} dashed>shared checkout untouched</Chiplet>
          </div>
        </>
      );
    case "checkFail":
      return (
        <>
          <PanelHead title="Check" sub="Verify" icon="shell" right={<Chiplet color={LINE}>{CHANGE.frozen}</Chiplet>} />
          <Terminal lines={[...CHECK_HEAD, { t: `✗ ${CHECK_FAIL}`, c: "#f0776f" }, { t: `  ${CHECK_WHY}` }, { t: "1 failed · 214 passed · 41s", c: SOL.base0 }]} />
          <Arrow color={BACK}>Checks failed: Fix check, in the same session</Arrow>
        </>
      );
    case "fix":
      return (
        <>
          <PanelHead title="Fix check" sub="a way back" color={BACK} right={<Chiplet color={BACK}>1 of 3</Chiplet>} />
          <SessionCard>
            <Note who="Check" color={BAD}>{CHECK_FAIL}: {CHECK_WHY}</Note>
            <div className="mt-3"><Visits label="Fix check" n={1} /></div>
          </SessionCard>
          <Arrow color={BACK}>back to Check on a new snapshot</Arrow>
        </>
      );
    case "checkPass":
      return (
        <>
          <PanelHead title="Check" sub="Verify" icon="shell" right={<Chiplet color={GOOD}>Passed</Chiplet>} />
          <Terminal lines={[...CHECK_HEAD, { t: `✓ 215 passed · 43s`, c: "#a7b84a" }]} />
          <Arrow color={LINE}>{b.sha}, a fresh snapshot, goes to Review</Arrow>
        </>
      );
    case "reviewAsk":
      return (
        <>
          <PanelHead title="Review" sub="an independent session" icon="agent" right={<Chiplet color={BACK}>↺ Changes asked</Chiplet>} />
          <Stats items={[["reviews", snapBefore, LINE], ["files", "2"], ["changed", "+20 −4"]]} />
          <Note who="reviewer" color={BACK}>{REVIEW_ASK}</Note>
          <Arrow color={BACK}>Address review, in the same session</Arrow>
        </>
      );
    case "address":
      return (
        <>
          <PanelHead title="Address review" sub="a way back" color={BACK} right={<Chiplet color={BACK}>1 of 3</Chiplet>} />
          <SessionCard>
            <Note who="reviewer" color={BACK}>{REVIEW_ASK}</Note>
            <div className="mt-3"><Visits label="Address review" n={1} /></div>
          </SessionCard>
          <Arrow color={BACK}>back to Check: the whole path runs again</Arrow>
        </>
      );
    case "reviewOk":
      return (
        <>
          <PanelHead title="Review" sub="an independent session" icon="agent" right={<Chiplet color={GOOD}>Approved</Chiplet>} />
          <Stats items={[["reviews", snapBefore, LINE], ["files", "2"], ["changed", "+24 −4"]]} />
          <Note who="reviewer" color={GOOD}>Both totals return 0 for an empty cart, with a test for each.</Note>
          <Arrow color={PERSON}>{snapBefore} goes to Decide</Arrow>
        </>
      );
    case "decide":
    case "pressed":
    case "dropped":
    case "cap": {
      const ended = b.kind === "dropped" || b.kind === "cap";
      return (
        <>
          <PanelHead title="Decide" sub="a person" icon="person" color={PERSON}
            right={<Chiplet color={b.tone === "bad" ? BAD : b.key === "R" ? BACK : PERSON} solid={ended}>{b.kind === "decide" ? "waiting on you" : b.kind === "cap" ? "run ended" : b.tag}</Chiplet>} />
          <DecideCard beat={b} onAnswer={onAnswer} paused={paused} lap={lap} />
          {b.kind === "decide" && <Arrow color={PERSON}>press S, R or D</Arrow>}
          {b.kind === "dropped" && <Arrow color={BAD}>the run ends; the change stays unshipped</Arrow>}
          {b.kind === "cap" && <Arrow color={BAD}>Revise has had its 3 visits; a fourth ends the run</Arrow>}
        </>
      );
    }
    case "revise":
      return (
        <>
          <PanelHead title="Revise" sub="a way back" color={BACK} right={<Chiplet color={BACK}>{b.visit} of 3</Chiplet>} />
          <SessionCard>
            <Note who="your note" color={PERSON}>Show the empty total as $0.00 on the receipt too.</Note>
            <div className="mt-3"><Visits label="Revise" n={b.visit ?? 1} /></div>
          </SessionCard>
          <Arrow color={BACK}>back to Check on a new snapshot</Arrow>
        </>
      );
    case "rebase":
    case "land": {
      const done = b.kind === "land";
      return (
        <>
          <PanelHead title="Land" sub="2 steps" icon="shell" />
          <div className="mt-3 grid gap-1.5 font-mono text-[12.5px]">
            {([["Rebase", "onto main, clean", true], ["Land", done ? `${CHANGE.landed} on main` : "next", done]] as const).map(([name, out, ok]) => (
              <div key={name} className="flex items-center gap-3 rounded-md px-3 h-9 border" style={{ borderColor: ok ? tint(LINE, 40) : HAIR, backgroundColor: ok ? tint(LINE, 7) : "transparent" }}>
                <span className="w-4 text-center" style={{ color: ok ? LINE : DIM }}>{ok ? "✓" : "·"}</span>
                <span className="w-16 font-semibold" style={{ color: INK }}>{name}</span>
                <span style={{ color: ok ? TEXT : DIM }}>{out}</span>
              </div>
            ))}
          </div>
          <Stats items={[["Review approved", snapBefore, GOOD], ["Decide accepted", snapBefore, PERSON], ["lands as", done ? CHANGE.landed : "·······", done ? LINE : DIM]]} />
        </>
      );
    }
    case "deploy":
      return (
        <>
          <PanelHead title="Deploy" sub="Wait for live" icon="shell" right={<Chiplet color={LINE}>parked</Chiplet>} />
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chiplet color={MUTED}>holds no slot</Chiplet>
            <Chiplet color={MUTED}>holds no session</Chiplet>
            <Chiplet color={MUTED}>waits up to 7 days</Chiplet>
          </div>
          <Targets live={false} />
          <Arrow color={LINE}>waits only for the targets whose paths it touches</Arrow>
        </>
      );
    default:
      return (
        <>
          <PanelHead title="Live" color="#1d7d76" right={<Chiplet color={LINE} solid>run complete</Chiplet>} />
          <Terminal lines={[{ t: LIVE_LINE, c: "#5fd0c6" }]} />
          <Targets live />
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 font-mono text-[12.5px]">
            <Chiplet color={GOOD}>Review approved {CHANGE.approved}</Chiplet>
            <span style={{ color: DIM }}>=</span>
            <Chiplet color={PERSON}>Decide accepted {CHANGE.approved}</Chiplet>
            <span style={{ color: DIM }}>rebased onto main</span>
            <Chiplet color={LINE} solid>{CHANGE.landed}</Chiplet>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 font-mono text-[12.5px]" style={{ borderColor: HAIR, backgroundColor: "#fffdf8" }}>
            <span style={{ color: DIM }}>next</span>
            <span className="font-semibold" style={{ color: INK }}>{CHANGE.task} watched</span>
            <span style={{ color: TEXT }}>{CHANGE.liveOn} to {CHANGE.watchUntil}</span>
            <a href="#ship" className="ml-auto underline underline-offset-4" style={{ color: "#1d7d76", textDecorationColor: tint(LINE, 60) }}>Ship and watch</a>
          </div>
        </>
      );
  }
}
