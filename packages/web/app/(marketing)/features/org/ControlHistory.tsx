"use client";

import { useState } from "react";
import { FileText, History, Network, Redo2, Settings2, Terminal, Undo2 } from "lucide-react";
import { Person, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, SOL, person, role, tint } from "./model";
import { DOOR_WORDS, type Door, type LogEntry } from "./controlData";

/*
 * The org's History, as the app draws it (components/org/history): newest
 * first, grouped by day, one entry per gesture with who, when and which door,
 * the before and after, and what else it did. Undo opens what it will change
 * back and what it cannot; taking it back strikes the entry and writes a new
 * one on top. A struck entry offers Redo.
 */

const DOOR_ICON: Record<Door, typeof FileText> = { proposal: FileText, settings: Settings2, chart: Network, cli: Terminal, history: History };

export function ControlHistory({ entries, onUndo, onRedo, onReset }: {
  entries: LogEntry[];
  onUndo: (id: string) => void;
  onRedo: (id: string) => void;
  onReset?: () => void;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  const days = (["Today", "Yesterday"] as const).map((d) => ({ d, rows: entries.filter((e) => e.day === d) })).filter((g) => g.rows.length);
  return (
    <div className="px-4 sm:px-5 py-4">
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2 items-start">
      {days.map(({ d, rows }) => (
        <section key={d}>
          <h3 className="flex items-center gap-2.5 mb-2.5 font-mono text-[10.5px] font-semibold" style={{ color: DIM }}>
            {d}<span className="flex-1 h-px" style={{ background: LINE }} />
          </h3>
          <ol className="relative">
            <span aria-hidden className="absolute left-[11px] top-2 bottom-2 w-px" style={{ background: LINE }} />
            {rows.map((e) => (
              <Entry key={e.id} e={e} asking={asking === e.id}
                onAsk={() => setAsking(e.id)} onClose={() => setAsking(null)}
                onUndo={() => { setAsking(null); onUndo(e.id); }} onRedo={() => onRedo(e.id)} />
            ))}
          </ol>
        </section>
      ))}
      </div>
      {onReset && (
        <button type="button" onClick={onReset} className="og-press mt-1 ml-[34px] font-mono text-[11px] underline underline-offset-2" style={{ color: MUTED }}>
          Start the demo over
        </button>
      )}
    </div>
  );
}

function ActorFace({ e }: { e: LogEntry }) {
  if (e.actor.kind === "person") {
    const p = person(e.actor.id);
    return <span className="inline-flex items-center gap-1.5 min-w-0"><Person p={p} size={16} /><span className="truncate">{p.name}</span></span>;
  }
  const r = role(e.actor.id);
  return <span className="inline-flex items-center gap-1.5 min-w-0"><Tile k={r.k} size={16} /><span className="truncate">{r.title}</span></span>;
}

function Entry({ e, asking, onAsk, onClose, onUndo, onRedo }: {
  e: LogEntry; asking: boolean; onAsk: () => void; onClose: () => void; onUndo: () => void; onRedo: () => void;
}) {
  const struck = !!e.undoneBy;
  const Icon = e.gesture === "undo" ? Undo2 : e.gesture === "redo" ? Redo2 : DOOR_ICON[e.door];
  const fresh = e.id.startsWith("n");
  const dot = struck ? DIM : e.gesture === "undo" ? SOL.violet : e.door === "proposal" ? SOL.violet : MUTED;
  const mayAct = !e.gesture;
  return (
    <li className={`relative pl-[34px] pb-4 last:pb-1 ${fresh ? "og-anim og-ctl-drop" : ""}`} data-undone={struck ? "" : undefined}>
      <span className="absolute left-0 top-0 w-[23px] h-[23px] rounded-full grid place-items-center" style={{ background: tint(dot, 14), color: dot, boxShadow: `0 0 0 3px #fffdf6` }}>
        <Icon className="w-3 h-3" />
      </span>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug font-medium" style={{ color: struck ? DIM : INK, textDecoration: struck ? "line-through" : undefined, textDecorationColor: tint(DIM, 80) }}>
            {e.line}
          </p>
          {e.change && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px]" style={{ opacity: struck ? 0.55 : 1 }}>
              <span className="px-1.5 py-px rounded" style={{ background: tint(SOL.red, 9), color: tint(SOL.red, 70, INK) }}>{e.change[0]}</span>
              <span style={{ color: DIM }}>→</span>
              <span className="px-1.5 py-px rounded" style={{ background: tint(SOL.green, 11), color: tint(SOL.green, 65, INK) }}>{e.change[1]}</span>
            </p>
          )}
          {e.effects.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {e.effects.map((x) => <li key={x} className="text-[11.5px] leading-snug" style={{ color: struck ? DIM : BODY }}>{x}</li>)}
            </ul>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-[11px] min-w-0" style={{ color: DIM }}>
            <ActorFace e={e} /><span>·</span><span>{e.at}</span><span>·</span>
            <span className="truncate">{DOOR_WORDS[e.door]}{e.doorRef ? ` ${e.doorRef}` : ""}</span>
          </p>
          {e.undoneBy && <p className="mt-0.5 text-[11px]" style={{ color: MUTED }}>Taken back by {e.undoneBy.name}, {e.undoneBy.at}</p>}
        </div>
        {mayAct && !asking && (
          <button type="button" onClick={struck ? onRedo : onAsk} className="og-press shrink-0 h-7 px-2.5 rounded-md border inline-flex items-center gap-1 font-mono text-[11.5px]"
            style={{ borderColor: LINE, color: struck ? SOL.violet : BODY, background: "#fffdf6" }} aria-label={`${struck ? "Redo" : "Undo"}: ${e.line}`}>
            {struck ? <Redo2 className="w-3 h-3" /> : <Undo2 className="w-3 h-3" />}{struck ? "Redo" : "Undo"}
          </button>
        )}
      </div>
      {asking && <Preview e={e} onConfirm={onUndo} onCancel={onClose} />}
    </li>
  );
}

function Preview({ e, onConfirm, onCancel }: { e: LogEntry; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="og-anim og-ctl-drop mt-2 rounded-lg border px-3 py-2.5" style={{ borderColor: tint(SOL.violet, 45), background: tint(SOL.violet, 6, "#fffdf6") }}>
      <div className="font-mono text-[10.5px] font-semibold mb-1" style={{ color: DIM }}>Will change back</div>
      <ul className="space-y-0.5">{(e.undoEffects ?? [e.line]).map((x) => <li key={x} className="text-[12px] leading-snug" style={{ color: INK }}>{x}</li>)}</ul>
      {e.cannot && (
        <>
          <div className="font-mono text-[10.5px] font-semibold mt-2 mb-1" style={{ color: DIM }}>Cannot be taken back</div>
          <ul>{e.cannot.map((x) => <li key={x} className="text-[12px] leading-snug" style={{ color: MUTED }}>{x}</li>)}</ul>
        </>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <button type="button" onClick={onConfirm} className="og-press h-7 px-3 rounded-md font-mono text-[11.5px] font-semibold" style={{ background: SOL.violet, color: "#fffdf6" }}>Take back</button>
        <button type="button" onClick={onCancel} className="og-press h-7 px-3 rounded-md font-mono text-[11.5px]" style={{ color: MUTED }}>Keep it</button>
      </div>
    </div>
  );
}
