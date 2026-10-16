"use client";

import type { CSSProperties } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleDashed } from "lucide-react";
import { SOL } from "../../blog/blogChrome";
import { DIM, LINE, MUTED, TEXT, tint } from "./theme";
import type { Extra, FactValue as FactValueData, Obj } from "./data";

/* The pill, its hover card and a mod kind's status badge, drawn the way the app draws them. */

/* ── The pill ─────────────────────────────────────────────────────────────── */

/** An object written inline: a faint tint of its color, its icon, its title, and the caret that opens it in place. */
export function Pill({ o, label, raw = false, className = "", style, hot }: { o: Obj; label?: string; raw?: boolean; className?: string; style?: CSSProperties; hot?: boolean }) {
  if (raw) {
    return <code className={`font-mono text-[0.86em] px-1 rounded ${className}`} style={{ backgroundColor: "rgba(147,161,161,.18)", color: TEXT, ...style }}>{o.id}</code>;
  }
  const I = o.icon;
  return (
    <span
      className={`md-pill inline-flex items-center gap-[0.25em] px-[0.25em] rounded-[0.25em] font-medium leading-none align-baseline whitespace-nowrap ${className}`}
      style={{ color: o.color, backgroundColor: tint(o.color, hot ? 18 : 9), opacity: o.done ? 0.6 : 1, boxShadow: hot ? `0 0 0 1.5px ${tint(o.color, 55)}` : undefined, ...style }}
    >
      <I className="w-[0.95em] h-[0.95em] shrink-0 opacity-85" style={o.iconTone ? { color: o.iconTone } : undefined} />
      <span className="py-[0.12em]">{label ?? o.title}</span>
      <ChevronDown className="w-[0.8em] h-[0.8em] shrink-0 opacity-50 -ml-[0.05em]" />
    </span>
  );
}

/* ── The hover card ───────────────────────────────────────────────────────── */

/** The preview a pill opens on hover: title and state, a few facts, a snippet, and a footer naming the object. */
export function HoverCard({ o, className = "", style }: { o: Obj; className?: string; style?: CSSProperties }) {
  const I = o.icon;
  return (
    <div className={`w-[300px] max-w-full rounded-lg border text-left ${className}`} style={{ backgroundColor: "#fffdf6", borderColor: LINE, boxShadow: "0 22px 48px -20px rgba(0,43,54,.45)", ...style }}>
      <div className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <I className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: o.iconTone ?? o.color }} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium leading-snug" style={{ color: TEXT }}>{o.title}</div>
            {o.state && (
              <div className="mt-1">
                {o.mod ? <StatusBadge label={o.state.label} color={o.state.color} /> : <span className="text-[10.5px] font-medium" style={{ color: o.state.color }}>{o.state.label}</span>}
              </div>
            )}
          </div>
        </div>
        {o.facts && o.facts.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-[22px] text-[11px]">
            {o.facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt style={{ color: DIM }}>{k}</dt>
                <dd className="min-w-0 truncate" style={{ color: MUTED }}><FactValue v={v} /></dd>
              </div>
            ))}
          </dl>
        )}
        {o.body && <p className="pl-[22px] text-[11px] leading-relaxed line-clamp-3" style={{ color: MUTED }}>{o.body}</p>}
        {o.extra && <div className="pl-[22px]"><CardExtra x={o.extra} /></div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: LINE, color: DIM }}>
        <span className="truncate font-mono">{o.foot ?? (o.mod ? `${o.id} · ${o.kind} · ${o.mod}` : o.id)}</span>
        <span className="inline-flex items-center gap-0.5 shrink-0">Open <ArrowUpRight className="w-2.5 h-2.5" /></span>
      </div>
    </div>
  );
}

/** A mod kind's status, as the app draws it: a dot and the word, on a tint of the status's tone. */
export function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10.5px] font-medium whitespace-nowrap" style={{ color, backgroundColor: tint(color, 14) }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}


/** A fact's value, in its tone when it has one. */
export function FactValue({ v }: { v: FactValueData }) {
  return typeof v === "string" ? <>{v}</> : <span style={{ color: v.tone }}>{v.text}</span>;
}

/** What a kind's card adds: a plan's progress, a decision's options, a call's lines, a change's size. */
function CardExtra({ x }: { x: Extra }) {
  if (x.kind === "diff") {
    return <div className="text-[11px] font-mono"><span style={{ color: SOL.green }}>+{x.add}</span> <span style={{ color: SOL.red }}>−{x.del}</span></div>;
  }
  if (x.kind === "quotes") {
    return (
      <div className="space-y-1 text-[11px] leading-snug" style={{ color: MUTED }}>
        {x.items.map(([who, said]) => <div key={said}><b style={{ color: TEXT, fontWeight: 600 }}>{who}</b> {said}</div>)}
      </div>
    );
  }
  if (x.kind === "options") {
    return (
      <div className="space-y-1">
        {x.items.map(([t, on], i) => (
          <div key={t} className="flex items-center gap-1.5 text-[11px] rounded px-1.5 py-0.5" style={{ color: on ? TEXT : DIM, backgroundColor: on ? tint(SOL.green, 10) : undefined }}>
            <span className="font-mono text-[10px]">{i + 1}</span>{t}{on && <Check className="w-3 h-3 ml-auto" style={{ color: SOL.green }} />}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "rgba(147,161,161,.2)" }}>
        <div className="h-full rounded-full" style={{ width: `${x.value * 100}%`, backgroundColor: x.color }} />
      </div>
      {x.items.map(([t, done]) => (
        <div key={t} className="flex items-center gap-1.5 text-[11px]" style={{ color: done ? DIM : MUTED }}>
          {done ? <Check className="w-3 h-3" style={{ color: SOL.green }} /> : <CircleDashed className="w-3 h-3" />}
          <span className={done ? "line-through" : ""}>{t}</span>
        </div>
      ))}
    </div>
  );
}
