"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Flame } from "lucide-react";
import { SOL } from "../../blog/blogChrome";
import { DIM, LINE, MUTED, TEXT, V, tint, ROLLOUT_SOURCE } from "./theme";
import { AppFrame, C, Section, Label } from "./kit";
import { FactValue, HoverCard, Pill, StatusBadge } from "./objects";
import { BUILT_IN, CUS_A, CUS_B, INC7, INC_STATUSES, PR, TASK, incident, statusTone, type Obj } from "./data";
import { RolloutBlock } from "./blocks";

/* ── 1. Written vs read ──────────────────────────────────────────────────── */

type Seg = string | { o: Obj } | { block: true };
const REPLY: Seg[][] = [
  ["The errors start with ", { o: PR }, ", which went out in the 2:10 deploy. I opened ", { o: TASK }, " to revert it and put the previous build on a canary:"],
  [{ block: true }],
  ["Hit hardest: ", { o: CUS_A }, " and ", { o: CUS_B }, ". Promote the canary once errors hold under 0.5%. Tracking it as ", { o: INC7 }, "."],
];
const SOURCE_CHARS = REPLY.flat().reduce((n, s) => n + (typeof s === "string" ? s.length : "o" in s ? s.o.id.length : ROLLOUT_SOURCE.length), 0);

export function WrittenVsRead() {
  const [hot, setHot] = useState<string | null>(null);
  const key = (s: Seg) => (typeof s === "string" ? null : "o" in s ? s.o.id : "rollout");
  const hover = (k: string | null) => ({ onMouseEnter: () => setHot(k), onMouseLeave: () => setHot(null) });
  return (
    <Section
      id="written"
      title="What the agent wrote, next to what you see"
      lede={<>Everything in that reply came from a few hundred characters of plain markdown: five ids and a three-field block. Codecast resolves each id from your workspace and draws it with its title and state; the block goes to the mod that claims it, which draws it from live data.</>}
      aside={<>Point at anything on either side to find its other half. The agent never formats a status, a price or a chart; it writes the id and codecast fills in the rest.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2 gap-5 items-stretch">
        <div className="rounded-xl border overflow-hidden flex flex-col" style={{ backgroundColor: SOL.base03, borderColor: "#0b4a5a" }}>
          <div className="h-9 px-4 flex items-center justify-between border-b font-mono text-[11.5px]" style={{ borderColor: "#0b4a5a", color: SOL.base01, backgroundColor: SOL.base02 }}>
            <span>what the agent wrote</span>
            <span className="tabular-nums">{SOURCE_CHARS} characters</span>
          </div>
          <div className="p-5 font-mono text-[12.5px] leading-[1.85] space-y-4 flex-1" style={{ color: SOL.base0 }}>
            {REPLY.map((para, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {para.map((s, j) => {
                  const k = key(s);
                  if (!k) return <span key={j}>{s as string}</span>;
                  return (
                    <span key={j} {...hover(k)} data-on={hot === k} className="md-hot cursor-default px-0.5" style={{ color: k === "rollout" ? SOL.cyan : SOL.yellow }}>
                      {k === "rollout" ? ROLLOUT_SOURCE : k}
                    </span>
                  );
                })}
              </p>
            ))}
          </div>
        </div>
        <div className="rounded-xl border p-5 text-[14px] leading-7 space-y-3" style={{ borderColor: LINE, backgroundColor: "#fffdf6", color: TEXT }}>
          <div className="font-mono text-[11.5px] -mt-1 mb-1" style={{ color: DIM }}>what you read</div>
          {REPLY.map((para, i) =>
            para[0] && typeof para[0] !== "string" && "block" in para[0] ? (
              <div key={i} {...hover("rollout")} className="md-hot" data-on={hot === "rollout"}><RolloutBlock /></div>
            ) : (
              <p key={i}>
                {para.map((s, j) => {
                  const k = key(s);
                  if (!k || typeof s === "string" || !("o" in s)) return <span key={j}>{s as string}</span>;
                  return <span key={j} {...hover(k)}><Pill o={s.o} hot={hot === k} /></span>;
                })}
              </p>
            ),
          )}
        </div>
      </div>
    </Section>
  );
}

/* ── 2. References stay true ─────────────────────────────────────────────── */

const MOMENTS = ["2:31 pm", "3:05 pm", "next morning"] as const;

function at3<T>(i: number, a: T, b: T, c: T): T { return i === 0 ? a : i === 1 ? b : c; }

export function StaysTrue() {
  const [m, setM] = useState(2);
  const inc = incident(7, INC7.title, at3(m, "mitigating", "monitoring", "resolved"), INC7.facts ?? [], INC7.body);
  const task: Obj = { ...TASK, state: at3(m, { label: "In progress · high", color: SOL.yellow }, { label: "Done", color: SOL.green }, { label: "Done", color: SOL.green }), iconTone: at3(m, SOL.yellow, SOL.green, SOL.green) };
  const cusB: Obj = { ...CUS_B, state: at3(m, { label: "churn risk", color: SOL.orange }, { label: "churn risk", color: SOL.orange }, { label: "active", color: SOL.green }), iconTone: at3(m, SOL.orange, SOL.orange, SOL.green) };
  return (
    <Section
      id="live"
      tone="sand"
      title="References keep updating after the message is sent"
      lede={<>A pill reads its object every time it draws, so the thread you scroll back to tomorrow shows where things stand now: the revert done, the incident resolved, the customer recovered. Nobody has to edit the old reply.</>}
      aside={<>A mod object that reaches its kind's last status dims in place, so finished items stand apart from open ones.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] gap-6 items-start">
        <div className="flex lg:flex-col gap-2" role="tablist" aria-label="When you read the reply">
          {MOMENTS.map((label, i) => (
            <button
              key={label}
              role="tab"
              aria-selected={m === i}
              onClick={() => setM(i)}
              className="md-tile flex-1 lg:flex-none text-left rounded-lg border px-3.5 py-2.5"
              style={{ borderColor: m === i ? V : LINE, backgroundColor: m === i ? tint(V, 8) : SOL.base3 }}
            >
              <span className="block font-mono text-[13px] font-semibold" style={{ color: m === i ? V : TEXT }}>{label}</span>
              <span className="block text-[11.5px] mt-0.5" style={{ color: MUTED }}>{at3(i, "the reply arrives", "revert merged", "the incident closed")}</span>
            </button>
          ))}
          <div className="hidden lg:block mt-3 pl-1 font-mono text-[11px]" style={{ color: DIM }}>same message, never edited</div>
        </div>
        <AppFrame title="Checkout failing for some customers" right={<span>{MOMENTS[m]}</span>}>
          <div className="p-5 text-[14.5px] leading-8" style={{ color: TEXT }}>
            The errors start with <Pill o={PR} />, which went out in the 2:10 deploy. I opened <Pill o={task} /> to revert it. Hit hardest: <Pill o={CUS_A} /> and <Pill o={cusB} />. Tracking it as <Pill o={inc} />.
          </div>
          <div className="px-5 pb-5 grid sm:grid-cols-2 gap-3">
            <HoverCard o={inc} className="w-full" />
            <HoverCard o={cusB} className="w-full" />
          </div>
        </AppFrame>
      </div>
    </Section>
  );
}

/* ── 3. The built-in vocabulary ──────────────────────────────────────────── */

export function Vocabulary() {
  const [pick, setPick] = useState(0);
  const o = BUILT_IN[pick];
  return (
    <Section
      id="built-in"
      tone="grid"
      title="Sixteen kinds built in"
      lede={<>Out of the box, codecast resolves its own objects wherever markdown renders: in replies, docs, task comments, chat and published pages. Each kind has its color, its mark and a card that shows what you would open it to learn. A task shows its status and owner, a pull request its checks and threads, a decision its options and which one you picked.</>}
      aside={<>Write <C>@[Title id]</C> to keep the title in full on every mention. A bare id shows its title the first time and stays short after that, so a paragraph that names one task five times still reads cleanly.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px] gap-8 items-start">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {BUILT_IN.map((b, i) => {
            const I = b.icon;
            const on = i === pick;
            return (
              <button
                key={b.kind}
                onMouseEnter={() => setPick(i)}
                onFocus={() => setPick(i)}
                onClick={() => setPick(i)}
                className="md-tile text-left rounded-lg border p-3"
                style={{ borderColor: on ? b.color : LINE, backgroundColor: on ? tint(b.color, 8) : "rgba(253,246,227,.85)" }}
              >
                <span className="flex items-center gap-1.5">
                  <I className="w-3.5 h-3.5" style={{ color: b.color }} />
                  <span className="text-[13px] font-semibold" style={{ color: TEXT }}>{b.kind}</span>
                </span>
                <span className="block mt-1.5 font-mono text-[11.5px] truncate" style={{ color: on ? b.color : DIM }}>{b.id}</span>
              </button>
            );
          })}
        </div>
        <div className="lg:sticky lg:top-24">
          <Label>in a sentence</Label>
          <p className="text-[14.5px] leading-8 mb-5" style={{ color: TEXT }}>
            See <Pill o={o} hot /> for the details.
          </p>
          <Label>on hover</Label>
          <HoverCard key={o.kind} o={o} className="md-pop w-full" />
        </div>
      </div>
    </Section>
  );
}

/* ── 4. Three depths ─────────────────────────────────────────────────────── */

function Depth({ n, title, note, children }: { n: number; title: string; note: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 flex flex-col">
      <div className="flex items-baseline gap-2.5 mb-3">
        <span className="font-mono text-[12px] w-5 h-5 grid place-items-center rounded-full" style={{ backgroundColor: tint(V, 14), color: V }}>{n}</span>
        <span className="font-mono font-bold text-[16px]" style={{ color: SOL.base03 }}>{title}</span>
      </div>
      <p className="text-[14px] leading-6 mb-4" style={{ color: MUTED }}>{note}</p>
      <div>{children}</div>
    </div>
  );
}

export function Depths() {
  const [open, setOpen] = useState(false);
  const tone = statusTone(INC_STATUSES, "mitigating");
  return (
    <Section
      id="depths"
      title="Open a reference as a pill, a card or a page"
      lede={<>The same reference opens three ways without leaving the conversation. Inside a sentence it is a pill. On a line of its own it becomes a card you can expand to full width. A click opens its page. The arrow on a pill opens that page right under the line, so you read it in place and fold it away.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-3 gap-8 md:gap-6">
        <Depth n={1} title="In a sentence" note="Its title and state, inline with the text.">
          <div className="rounded-xl border p-4 text-[14px] leading-7" style={{ borderColor: LINE, backgroundColor: "#fffdf6", color: TEXT }}>
            Rolled back after <Pill o={INC7} /> and paused the deploy train.
          </div>
        </Depth>
        <Depth n={2} title="On its own line" note="A card with a real snippet, which expands to the full width of the reply.">
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: tint(V, 30), backgroundColor: "#fffdf6" }}>
            <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 text-left" style={{ backgroundColor: tint(V, open ? 14 : 9) }}>
              <Flame className="w-3.5 h-3.5" style={{ color: tone }} />
              <span className="text-[13px] font-medium truncate" style={{ color: TEXT }}>{INC7.title}</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto shrink-0 transition-transform" style={{ color: V, transform: open ? "rotate(180deg)" : undefined }} />
            </button>
            <div className="px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2"><StatusBadge label="mitigating" color={tone} /><span className="text-[11px]" style={{ color: DIM }}>sev-2 · payments-api</span></div>
              <p className={`text-[12px] leading-relaxed ${open ? "" : "line-clamp-2"}`} style={{ color: MUTED }}>
                {INC7.body} {open && "Commander Dana. Customer impact: failed card charges for accounts on the Scale plan; retries succeed once the canary takes them."}
              </p>
              {open && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] pt-1">
                  {(INC7.facts ?? []).map(([k, v]) => <span key={k}><span style={{ color: DIM }}>{k} </span><span style={{ color: MUTED }}><FactValue v={v} /></span></span>)}
                </div>
              )}
            </div>
          </div>
        </Depth>
        <Depth n={3} title="Its own page" note="Every field, editable. The mod can draw its own view above them.">
          <div className="rounded-xl border p-4" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
            <div className="flex items-center gap-1 text-[10.5px] font-mono mb-2" style={{ color: DIM }}>Incidents <ChevronRight className="w-3 h-3" /> inc-7</div>
            <div className="text-[15px] font-semibold leading-snug" style={{ color: TEXT }}>{INC7.title}</div>
            <div className="mt-2 flex gap-1 flex-wrap">
              {INC_STATUSES.map((s) => {
                const on = s === "mitigating";
                const t = statusTone(INC_STATUSES, s);
                return <span key={s} className="rounded-full px-2 py-[1px] text-[10.5px] font-medium border" style={{ color: on ? t : DIM, borderColor: on ? t : LINE, backgroundColor: on ? tint(t, 12) : undefined }}>{s}</span>;
              })}
            </div>
            <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              {(INC7.facts ?? []).map(([k, v]) => (
                <div key={k} className="contents"><span style={{ color: DIM }}>{k}</span><span className="rounded px-1.5 -mx-1.5" style={{ color: TEXT, backgroundColor: "rgba(238,232,213,.5)" }}><FactValue v={v} /></span></div>
              ))}
            </div>
            <p className="mt-3 pt-2 border-t text-[11.5px] leading-relaxed" style={{ borderColor: LINE, color: MUTED }}>{INC7.body}</p>
          </div>
        </Depth>
      </div>
    </Section>
  );
}

