"use client";

import { useState, type CSSProperties } from "react";
import { SOL } from "../../blog/blogChrome";
import { ACTION_ITEMS, AGENT, AGENT_BATCHES, AGENT_REPLY, CALL_ID, CALL_LENGTH, CALL_TITLE, LINES, PEOPLE, speakerOf } from "./data";
import { AgentMark, Face, TaskChip } from "./parts";

/** Deterministic bar heights so the waveform is stable between renders. */
function bars(seed: number, n: number): number[] {
  let x = seed * 9301 + 49297;
  return Array.from({ length: n }, (_, i) => {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    const env = Math.sin(((i + 0.5) / n) * Math.PI);
    return 0.25 + 0.75 * env * (0.45 + 0.55 * r);
  });
}

const LANE_H = 34;

/**
 * The hero: the huddle as a multitrack. Each person has their own lane,
 * because the scribe streams each person's track to recognition on its own
 * connection; that is why every transcript line knows its speaker. The fed
 * session's lane shows the words arriving in batches when the room goes
 * quiet, and its reply landing in the huddle chat. When the playhead runs
 * out, the digest appears.
 */
export function CallScore() {
  const [hot, setHot] = useState<number | null>(null);

  return (
    <div
      className="rounded-2xl overflow-hidden text-left font-mono"
      style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}`, boxShadow: "0 30px 80px -40px rgba(0,43,54,0.45)" }}
      role="img"
      aria-label={`A huddle shown as one lane per speaker, with the transcript lines each lane produced and the digest written when it ended`}
    >
      {/* Room header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-5 py-3" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
        <span className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: SOL.base02 }}>
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SOL.green }} />
          Huddle in #payments
        </span>
        <span className="rounded-full px-2 py-0.5 text-[10.5px]" style={{ backgroundColor: "rgba(211,54,130,0.1)", color: SOL.magenta }}>transcribing</span>
        <span className="ml-auto flex items-center -space-x-1.5">
          {PEOPLE.map((p) => <Face key={p.id} p={p} size={24} ring="#fffaf0" />)}
        </span>
        <span className="text-[11px]" style={{ color: SOL.base1 }}>{CALL_ID}</span>
      </div>

      {/* Lanes */}
      <div className="px-3 sm:px-5 pt-4 pb-3">
        <div className="flex">
          <div className="shrink-0 w-[34px] sm:w-[118px]">
            {PEOPLE.map((p) => (
              <div key={p.id} className="flex items-center gap-2" style={{ height: LANE_H, marginBottom: 6 }}>
                <Face p={p} size={22} />
                <span className="hidden sm:inline text-[12px]" style={{ color: SOL.base01 }}>{p.name}</span>
              </div>
            ))}
            <div className="flex items-center gap-2" style={{ height: LANE_H }}>
              <AgentMark size={22} />
              <span className="hidden sm:flex flex-col leading-tight">
                <span className="text-[11.5px]" style={{ color: SOL.magenta }}>session</span>
                <span className="text-[10px]" style={{ color: SOL.base1 }}>fed live</span>
              </span>
            </div>
          </div>

          <div className="relative flex-1 min-w-0 cc-grid rounded-md">
            {PEOPLE.map((p) => (
              <div key={p.id} className="relative" style={{ height: LANE_H, marginBottom: 6, borderBottom: "1px dashed rgba(147,161,161,0.25)" }}>
                {LINES.filter((l) => l.speaker === p.id).map((l) => {
                  const hs = bars(l.seq, Math.max(6, Math.round((l.to - l.from) * 70)));
                  return (
                    <div
                      key={l.seq}
                      className="cc-seg absolute top-1 bottom-1 flex items-center gap-[2px] rounded-[5px] px-[3px]"
                      data-hot={hot === l.seq}
                      style={{ left: `${l.from * 100}%`, width: `${(l.to - l.from) * 100}%`, backgroundColor: `color-mix(in srgb, ${p.color} 13%, transparent)`, "--at": l.from, "--c": p.color } as CSSProperties}
                    >
                      {hs.map((h, i) => (
                        <span key={i} className="flex-1 rounded-full" style={{ height: `${h * 100}%`, backgroundColor: p.color, minWidth: 1.5 }} />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
            {/* The fed session's lane: deliveries and its reply in the huddle chat */}
            <div className="relative" style={{ height: LANE_H }}>
              <div className="absolute left-0 right-0 top-1/2" style={{ borderTop: `1px dotted ${SOL.base1}` }} />
              {AGENT_BATCHES.map((at, i) => (
                <span
                  key={i}
                  className="cc-batch absolute top-1/2 -translate-y-1/2 -ml-[7px] flex h-[14px] w-[14px] items-center justify-center rounded-full"
                  style={{ left: `${at * 100}%`, backgroundColor: SOL.magenta, "--at": at } as CSSProperties}
                  title="The room went quiet: the words so far reach the session"
                >
                  <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="#fff" strokeWidth={3}><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                </span>
              ))}
              <span
                className="cc-batch absolute top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] whitespace-nowrap"
                style={{ left: "77.5%", backgroundColor: SOL.base02, color: SOL.base2, "--at": 0.78 } as CSSProperties}
              >
                reply in huddle chat
              </span>
            </div>

            <div className="cc-playhead pointer-events-none absolute -top-2 -bottom-2 w-[2px]" style={{ left: "100%", opacity: 0, backgroundColor: SOL.magenta, boxShadow: `0 0 0 3px rgba(211,54,130,0.15)` }} />
          </div>
        </div>
        <div className="mt-2 flex justify-between pl-[34px] sm:pl-[118px] text-[10px]" style={{ color: SOL.base1 }}>
          <span>0:00</span><span>0:15</span><span>0:30</span><span>0:45</span><span>1:00</span>
        </div>
      </div>

      {/* Transcript and digest */}
      <div className="grid lg:grid-cols-[1.35fr_1fr]" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <div className="px-3 sm:px-5 py-4" style={{ backgroundColor: "#fdf6e3" }}>
          <div className="mb-2 flex items-center gap-2 text-[11px]" style={{ color: SOL.base1 }}>
            <span>Transcript</span>
            <span className="ml-auto hidden sm:inline">hover a line</span>
          </div>
          <ol className="space-y-0.5">
            {LINES.map((l) => {
              const s = speakerOf(l.speaker);
              return (
                <li
                  key={l.seq}
                  className="cc-line grid grid-cols-[auto_1fr] gap-x-2.5 rounded-md px-2 py-1.5 cursor-default"
                  style={{ "--at": l.from, backgroundColor: hot === l.seq ? `color-mix(in srgb, ${s.color} 10%, transparent)` : undefined } as CSSProperties}
                  onMouseEnter={() => setHot(l.seq)}
                  onMouseLeave={() => setHot(null)}
                >
                  <span className="text-[10.5px] pt-[2px] tabular-nums" style={{ color: SOL.base1 }}>{CALL_ID}:{l.seq}</span>
                  <span className="text-[12.5px] leading-snug min-w-0" style={{ color: SOL.base01 }}>
                    <span className="font-semibold" style={{ color: s.color }}>{s.name}</span>
                    <span className="mx-1.5 text-[10.5px]" style={{ color: SOL.base1 }}>{l.at}</span>
                    {l.text}
                  </span>
                </li>
              );
            })}
            <li className="cc-line ml-2 mt-1.5 rounded-md px-2.5 py-2 text-[11.5px] leading-snug" style={{ "--at": 0.78, borderLeft: `2px solid ${SOL.magenta}`, backgroundColor: "rgba(211,54,130,0.06)", color: SOL.base01 } as CSSProperties}>
              <span className="font-semibold" style={{ color: SOL.magenta }}>{AGENT.name}</span>
              <span className="mx-1.5 text-[10px]" style={{ color: SOL.base1 }}>huddle chat</span>
              {AGENT_REPLY}
            </li>
          </ol>
        </div>

        <div className="cc-after px-4 sm:px-5 py-4" style={{ borderLeft: `1px solid ${SOL.base2}` }}>
          <div className="flex items-center gap-2 text-[11px]" style={{ color: SOL.base1 }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.base1 }} />
            Huddle ended, digest posted
          </div>
          <div className="mt-2 text-[15px] font-bold" style={{ color: SOL.base03 }}>{CALL_TITLE}</div>
          <div className="text-[11px]" style={{ color: SOL.base1 }}>{CALL_LENGTH} · Maya, Theo, Priya</div>
          <div className="mt-3 text-[11px] font-semibold" style={{ color: SOL.base01 }}>Action items</div>
          <ol className="mt-1.5 space-y-2">
            {ACTION_ITEMS.map((a, i) => (
              <li key={a.task} className="text-[12px] leading-snug" style={{ color: SOL.base01 }}>
                <span style={{ color: SOL.base1 }}>{i + 1}. </span>{a.text}
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <TaskChip id={a.task} />
                  <span className="text-[10.5px]" style={{ color: SOL.base1 }}>from {CALL_ID}:{a.line}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
