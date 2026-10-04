"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { ACTION_ITEMS, AGENT, CALL_ID, CALL_LEAD, CALL_TITLE, PEOPLE, SUMMARY, lineAt, speakerOf } from "./data";
import { AgentMark, CallPill, Face, Frame, TaskChip } from "./parts";

const hair = `1px solid ${SOL.base2}`;

/* ------------------------------------------------------------------ */
/* 01: one track per voice                                             */
/* ------------------------------------------------------------------ */

/** Three microphone tracks, three recognition streams, three stamped segments. */
export function TrackDiagram() {
  const rows = [
    { p: PEOPLE[0], seq: 1 },
    { p: PEOPLE[1], seq: 2 },
    { p: PEOPLE[2], seq: 3 },
  ];
  return (
    <Frame label="Each person's audio track goes to speech recognition on its own stream, so each segment is stamped with its speaker">
      <div className="grid grid-cols-[auto_1fr] sm:grid-cols-[auto_auto_1fr] items-stretch">
        <div className="px-4 py-3 text-[10.5px] col-span-full flex flex-wrap gap-x-6 gap-y-1" style={{ borderBottom: hair, color: SOL.base1 }}>
          <span>track</span>
          <span className="hidden sm:inline">scribe streams it alone</span>
          <span className="ml-auto">segment, as stored</span>
        </div>
        {rows.map(({ p, seq }, i) => {
          const l = lineAt(seq);
          return (
            <div key={p.id} className="contents">
              <div className="cc-rise flex items-center gap-2 px-4 py-4" style={{ borderBottom: i < 2 ? hair : undefined, "--d": `${i * 0.12}s` } as CSSProperties}>
                <Face p={p} size={28} />
                <span className="hidden sm:inline text-[12px]" style={{ color: SOL.base01 }}>{p.name}&apos;s mic</span>
              </div>
              <div className="hidden sm:flex items-center px-2" style={{ borderBottom: i < 2 ? hair : undefined }}>
                <svg width="150" height="20" viewBox="0 0 150 20" aria-hidden>
                  <path d="M0 10 H130" stroke={p.color} strokeWidth="2" strokeDasharray="4 4" />
                  <path d="M128 4 L138 10 L128 16" fill="none" stroke={p.color} strokeWidth="2" />
                  <rect x="40" y="2" width="56" height="16" rx="8" fill="#fffaf0" stroke={p.color} />
                  <text x="68" y="13.5" textAnchor="middle" fontSize="9" fill={p.color} fontFamily="ui-monospace, monospace">stream {i + 1}</text>
                </svg>
              </div>
              <div className="cc-rise min-w-0 px-4 py-3" style={{ borderBottom: i < 2 ? hair : undefined, "--d": `${0.3 + i * 0.12}s` } as CSSProperties}>
                <div className="rounded-lg px-3 py-2 text-[11px] leading-[1.6] overflow-x-auto" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
                  <span style={{ color: SOL.base01 }}>{"{ "}</span>
                  <span>seq: </span><span style={{ color: SOL.cyan }}>{seq}</span>
                  <span>, speaker_name: </span><span style={{ color: SOL.yellow }}>&quot;{p.name}&quot;</span>
                  <span>, text: </span><span style={{ color: SOL.base1 }}>&quot;{l.text.length > 38 ? l.text.slice(0, 36) + "…" : l.text}&quot;</span>
                  <span style={{ color: SOL.base01 }}>{" }"}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ */
/* 02: the digest                                                      */
/* ------------------------------------------------------------------ */

function DigestBody() {
  return (
    <>
      <div className="text-[14px] font-bold" style={{ color: SOL.base03 }}>{CALL_TITLE}</div>
      <div className="text-[11px]" style={{ color: SOL.base1 }}>{CALL_LEAD}</div>
      <p className="mt-2 text-[12px] leading-[1.6]" style={{ color: SOL.base01 }}>{SUMMARY}</p>
      <div className="mt-2.5 text-[11px] font-semibold" style={{ color: SOL.base01 }}>Action items</div>
      <ol className="mt-1 space-y-1 text-[12px] leading-snug" style={{ color: SOL.base01 }}>
        {ACTION_ITEMS.map((a, i) => <li key={a.task}><span style={{ color: SOL.base1 }}>{i + 1}. </span>{a.text}</li>)}
      </ol>
    </>
  );
}

/** Where a channel huddle's digest lands: a chat message in the channel. */
export function ChannelDigest() {
  return (
    <Frame className="cc-lift h-full" label="A huddle digest posted as a chat message in the channel">
      <div className="flex items-center gap-2 px-4 py-2.5 text-[12px]" style={{ borderBottom: hair, color: SOL.base02 }}>
        <span style={{ color: SOL.base1 }}>#</span>payments
        <span className="ml-auto text-[10.5px]" style={{ color: SOL.base1 }}>channel or DM</span>
      </div>
      <div className="px-4 py-4 flex gap-3">
        <Face p={PEOPLE[0]} size={28} />
        <div className="min-w-0">
          <div className="text-[11.5px]" style={{ color: SOL.base1 }}><span className="font-semibold" style={{ color: SOL.base02 }}>Maya</span> · huddle digest</div>
          <div className="mt-1.5 rounded-lg px-3 py-2.5" style={{ border: hair, backgroundColor: "#fdf6e3" }}>
            <DigestBody />
            <div className="mt-2.5 text-[11px]" style={{ color: SOL.blue }}>Show transcript (6 lines)</div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** Where a session room's digest lands: a message that wakes the agent. */
export function SessionDigest() {
  return (
    <Frame className="cc-lift h-full" label="A huddle digest delivered into a session as a message that wakes its agent">
      <div className="flex items-center gap-2 px-4 py-2.5 text-[12px]" style={{ borderBottom: hair, color: SOL.base02 }}>
        <AgentMark size={18} /> {AGENT.name}
        <span className="text-[10.5px]" style={{ color: SOL.blue }}>{AGENT.backend}</span>
        <span className="ml-auto text-[10.5px]" style={{ color: SOL.base1 }}>session room</span>
      </div>
      <div className="px-4 py-4 text-[11.5px] leading-[1.7]" style={{ color: SOL.base01 }}>
        <div style={{ color: SOL.magenta }}>&lt;huddle-summary&gt;</div>
        <div className="pl-3 my-1" style={{ borderLeft: `2px solid rgba(211,54,130,0.3)` }}>
          <div>The huddle in this session&apos;s room just ended. You already heard it live, line by line, while it ran.</div>
          <div className="mt-1.5"><span className="font-semibold" style={{ color: SOL.base03 }}>{CALL_TITLE}</span> · {CALL_LEAD}</div>
          <div className="mt-1">Action items: 2</div>
          <div className="mt-1.5">Read the whole transcript with <span style={{ color: SOL.base02 }}>cast call {CALL_ID} --transcript</span></div>
        </div>
        <div style={{ color: SOL.magenta }}>&lt;/huddle-summary&gt;</div>
        <div className="mt-3 flex items-center gap-2 text-[11px]" style={{ color: SOL.green }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.green }} /> agent woke · working
        </div>
        <div className="mt-3 rounded-lg px-3 py-2.5 text-[11px] leading-[1.65]" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
          <div><span style={{ color: SOL.green }}>$ </span><span style={{ color: SOL.base2 }}>cast call {CALL_ID} 3:4</span></div>
          <div style={{ color: SOL.base01 }}>{CALL_TITLE} lines 3-4</div>
          <div style={{ color: SOL.cyan }}>Priya</div>
          <div className="truncate pl-3"><span style={{ color: SOL.base01 }}>{CALL_ID}:3 0:19</span> Can we move to exponential with jitter before Friday?</div>
          <div style={{ color: SOL.cyan }}>Theo</div>
          <div className="truncate pl-3"><span style={{ color: SOL.base01 }}>{CALL_ID}:4 0:24</span> Yes, I&apos;ll take it. I&apos;ll add a dead letter queue while I&apos;m in there.</div>
        </div>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ */
/* 03: citations                                                       */
/* ------------------------------------------------------------------ */

/** A message that cites the call: an inline pill and an embedded line range. */
export function CitationMessage() {
  return (
    <Frame label="An agent's message citing the call: an inline call pill and lines 3 to 4 embedded with their speakers">
      <div className="flex items-center gap-2 px-4 py-2.5 text-[12px]" style={{ borderBottom: hair, color: SOL.base02 }}>
        <AgentMark size={18} /> {AGENT.name}
        <span className="ml-auto text-[10.5px]" style={{ color: SOL.base1 }}>message</span>
      </div>
      <div className="px-4 py-4 text-[13px] leading-[1.7]" style={{ color: SOL.base01 }}>
        <p>
          Switching retries to exponential backoff with jitter. This was agreed in <CallPill>{CALL_TITLE} · 6m</CallPill>, and the deadline is Friday:
        </p>
        <div className="my-3 rounded-lg overflow-hidden" style={{ border: `1px solid rgba(211,54,130,0.25)` }}>
          <div className="flex items-center gap-2 px-3 py-1.5 text-[10.5px]" style={{ backgroundColor: "rgba(211,54,130,0.07)", color: SOL.magenta }}>
            {CALL_ID}:3-4 <span style={{ color: SOL.base1 }}>· {CALL_TITLE}</span>
          </div>
          {[3, 4].map((n) => {
            const l = lineAt(n);
            const s = speakerOf(l.speaker);
            return (
              <div key={n} className="flex gap-2.5 px-3 py-2 text-[12px]" style={{ borderTop: hair }}>
                <Face p={s} size={20} />
                <div className="min-w-0">
                  <span className="font-semibold" style={{ color: s.color }}>{s.name}</span>
                  <span className="ml-2 text-[10.5px]" style={{ color: SOL.base1 }}>{l.at}</span>
                  <div style={{ color: SOL.base02 }}>{l.text}</div>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[11.5px]" style={{ color: SOL.base1 }}>Written as <span style={{ color: SOL.base02 }}>{CALL_ID}</span> and <span style={{ color: SOL.base02 }}>{CALL_ID}:3-4</span> on its own line.</p>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ */
/* 04: from call to tasks                                              */
/* ------------------------------------------------------------------ */

/** Action item, the line it was agreed on, the task that quotes it. */
export function ItemToTask() {
  return (
    <div className="space-y-4">
      {ACTION_ITEMS.map((a, i) => {
        const l = lineAt(a.line);
        const s = speakerOf(l.speaker);
        return (
          <div key={a.task} className="cc-rise grid gap-3 md:grid-cols-[1fr_auto_1.15fr_auto_1fr] md:items-center" style={{ "--d": `${i * 0.15}s` } as CSSProperties}>
            <Frame className="px-3.5 py-3 h-full">
              <div className="text-[10.5px] mb-1" style={{ color: SOL.base1 }}>action item {i + 1}</div>
              <div className="text-[12px] leading-snug" style={{ color: SOL.base01 }}>{a.text}</div>
            </Frame>
            <Arrow />
            <Frame className="px-3.5 py-3 h-full" style={{ borderColor: `color-mix(in srgb, ${s.color} 35%, transparent)` }}>
              <div className="text-[10.5px] mb-1" style={{ color: SOL.base1 }}>checked against {CALL_ID}:{a.line}</div>
              <div className="flex gap-2 text-[12px] leading-snug">
                <Face p={s} size={18} />
                <span style={{ color: SOL.base02 }}><span className="font-semibold" style={{ color: s.color }}>{s.name}: </span>&ldquo;{l.text}&rdquo;</span>
              </div>
            </Frame>
            <Arrow />
            <Frame className="px-3.5 py-3 h-full">
              <div className="flex items-center gap-2 text-[10.5px] mb-1" style={{ color: SOL.base1 }}>
                <TaskChip id={a.task} /> <span>from a meeting</span>
              </div>
              <div className="text-[12.5px] font-semibold leading-snug" style={{ color: SOL.base03 }}>{a.title}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: SOL.base1 }}>
                <Face p={speakerOf(a.owner)} size={16} /> {speakerOf(a.owner).name}
              </div>
            </Frame>
          </div>
        );
      })}
    </div>
  );
}

function Arrow() {
  return (
    <span className="flex justify-center" aria-hidden>
      <svg className="h-5 w-5 rotate-90 md:rotate-0" viewBox="0 0 24 24" fill="none" stroke={SOL.base1} strokeWidth={2}><path d="M4 12h15M13 6l6 6-6 6" /></svg>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 05: an agent in the room                                            */
/* ------------------------------------------------------------------ */

/**
 * How words reach a fed session: in batches whenever the room goes quiet;
 * held while the agent asked for time, except a line that names it; then
 * everything said meanwhile at once when the hold ends.
 */
export function DeliveryTimeline() {
  // Positions are fractions of the strip's width.
  const speech: [number, number, string][] = [
    [0.02, 0.12, SOL.blue], [0.14, 0.22, SOL.green], [0.27, 0.36, SOL.violet],
    [0.43, 0.52, SOL.blue], [0.53, 0.6, SOL.green], [0.64, 0.7, SOL.violet], [0.74, 0.8, SOL.blue],
    [0.9, 0.97, SOL.green],
  ];
  const deliveries: { at: number; kind: "quiet" | "named" | "released" }[] = [
    { at: 0.245, kind: "quiet" },
    { at: 0.38, kind: "quiet" },
    { at: 0.705, kind: "named" },
    { at: 0.84, kind: "released" },
  ];
  const holdFrom = 0.4;
  const holdTo = 0.84;
  const color = { quiet: SOL.magenta, named: SOL.orange, released: SOL.cyan };
  return (
    <Frame label="A timeline of a huddle feeding a session: deliveries when the room goes quiet, a hold where words wait, a line naming the agent that comes through anyway, and the release when the hold ends">
      <div className="px-4 sm:px-6 pt-5 pb-4">
        <div className="relative h-[120px]">
          {/* hold window */}
          <div className="absolute top-0 bottom-0 rounded-md" style={{ left: `${holdFrom * 100}%`, width: `${(holdTo - holdFrom) * 100}%`, background: `repeating-linear-gradient(135deg, rgba(42,161,152,0.10) 0 6px, transparent 6px 12px)`, border: `1px dashed rgba(42,161,152,0.5)` }}>
            <span className="absolute -top-0 left-2 translate-y-1 text-[10.5px] rounded px-1.5" style={{ color: SOL.cyan, backgroundColor: "#fffaf0" }}>cast call hold 10m</span>
          </div>
          {/* room speech */}
          <div className="absolute left-0 right-0 top-[34px] h-[22px]">
            <span className="absolute -top-[16px] left-0 text-[10px]" style={{ color: SOL.base1 }}>the room</span>
            {speech.map(([a, b, c], i) => (
              <span key={i} className="absolute top-0 bottom-0 rounded-[4px]" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%`, backgroundColor: `color-mix(in srgb, ${c} 55%, transparent)` }} />
            ))}
            <span className="absolute top-0 bottom-0 rounded-[4px] ring-2" style={{ left: "64%", width: "6%", backgroundColor: `color-mix(in srgb, ${SOL.violet} 55%, transparent)`, boxShadow: `0 0 0 2px ${SOL.orange}` }} />
          </div>
          {/* session lane */}
          <div className="absolute left-0 right-0 top-[86px] h-[22px]">
            <span className="absolute -top-[16px] left-0 text-[10px]" style={{ color: SOL.base1 }}>the session</span>
            <span className="absolute left-0 right-0 top-1/2" style={{ borderTop: `1px dotted ${SOL.base1}` }} />
            {deliveries.map((d, i) => (
              <span key={i} className="absolute top-1/2 -translate-y-1/2 -ml-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-full" style={{ left: `${d.at * 100}%`, backgroundColor: color[d.kind] }}>
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="#fff" strokeWidth={3}><path d="M12 5v14M5 12l7 7 7-7" /></svg>
              </span>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[11.5px] leading-snug" style={{ color: SOL.base01 }}>
          <Legend c={SOL.magenta}>The room goes quiet: the words so far arrive as one batch.</Legend>
          <Legend c={SOL.orange}>A line that names the agent comes through during a hold.</Legend>
          <Legend c={SOL.cyan}>The hold ends: everything said meanwhile arrives together.</Legend>
        </div>
      </div>
    </Frame>
  );
}

function Legend({ c, children }: { c: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="mt-[3px] h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c }} />
      <span>{children}</span>
    </div>
  );
}

/** The huddle chat with the fed session's reply mirrored in. */
export function HuddleChat() {
  return (
    <Frame label="The huddle's text chat, where the fed session's reply appears as its own line and a person's typed line is relayed to it">
      <div className="flex items-center gap-2 px-4 py-2.5 text-[12px]" style={{ borderBottom: hair, color: SOL.base02 }}>
        Huddle chat
        <span className="ml-auto flex items-center -space-x-1.5">
          {PEOPLE.map((p) => <Face key={p.id} p={p} size={20} ring="#fffaf0" />)}
          <span className="pl-2"><AgentMark size={20} /></span>
        </span>
      </div>
      <div className="px-4 py-3 space-y-3 text-[12px] leading-snug">
        <div className="flex gap-2.5">
          <Face p={PEOPLE[0]} size={22} />
          <div><div className="text-[11px] font-semibold" style={{ color: SOL.blue }}>Maya</div><div style={{ color: SOL.base02 }}>split the 41 by customer please</div><div className="mt-0.5 text-[10px]" style={{ color: SOL.base1 }}>relayed to the session</div></div>
        </div>
        <div className="flex gap-2.5">
          <AgentMark size={22} />
          <div className="min-w-0">
            <div className="text-[11px]"><span className="font-semibold" style={{ color: SOL.magenta }}>{AGENT.name}</span> <span className="ml-1 rounded px-1 text-[9.5px]" style={{ backgroundColor: "rgba(211,54,130,0.1)", color: SOL.magenta }}>agent</span></div>
            <div style={{ color: SOL.base02 }}>Seven customers. Northwind has 22 of them, the rest have one to five each. Table is in the session.</div>
            <div className="mt-1 text-[10.5px]" style={{ color: SOL.blue }}>open session</div>
          </div>
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className="relative flex aspect-[16/7] items-center justify-center rounded-lg" style={{ background: `radial-gradient(ellipse 45% 70% at 50% 50%, rgba(211,54,130,0.2), ${SOL.base03})` }} role="img" aria-label="The agent's video tile in the huddle, marked as an agent">
          <AgentMark size={54} />
          <span className="absolute left-2 bottom-2 flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: "rgba(0,0,0,0.45)", color: SOL.base2 }}>
            {AGENT.name}<span className="rounded px-1 text-[9px]" style={{ backgroundColor: SOL.magenta, color: "#fff" }}>agent</span>
          </span>
          <span className="cc-talking absolute right-2 bottom-2 flex items-center gap-[2px]" aria-hidden>
            {[5, 9, 6, 11, 7].map((h, k) => <span key={k} className="w-[2px] rounded-full" style={{ height: h, backgroundColor: SOL.magenta, "--i": k } as CSSProperties} />)}
          </span>
        </div>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ */
/* 06: video and frames                                                */
/* ------------------------------------------------------------------ */

/** A frame of a recorded call, as `cast call snap` writes it and a citation renders it. */
export function SnapFrame() {
  const l = lineAt(4);
  return (
    <Frame label="A frame from a recorded call's shared screen, with its citation and the line being said at that moment">
      <div className="relative aspect-[16/9]" style={{ backgroundColor: SOL.base03 }}>
        {/* a shared code editor */}
        <div className="absolute inset-0 flex">
          <div className="hidden sm:block w-[22%] p-3 space-y-1.5" style={{ backgroundColor: SOL.base02 }}>
            {["retry.ts", "queue.ts", "webhook.ts", "dlq.ts"].map((f, i) => (
              <div key={f} className="text-[10px] rounded px-1.5 py-0.5" style={{ color: i === 0 ? SOL.base2 : SOL.base01, backgroundColor: i === 0 ? "rgba(147,161,161,0.15)" : undefined }}>{f}</div>
            ))}
          </div>
          <pre className="flex-1 p-4 text-[10.5px] sm:text-[11.5px] leading-[1.7] overflow-hidden" style={{ color: SOL.base0 }}>
            <span style={{ color: SOL.base01 }}>{"// retry.ts\n"}</span>
            <span style={{ color: SOL.green }}>export function </span><span style={{ color: SOL.blue }}>nextDelay</span>(attempt: <span style={{ color: SOL.yellow }}>number</span>) {"{\n"}
            {"  "}<span style={{ color: SOL.green }}>const</span> base = <span style={{ color: SOL.cyan }}>500</span> * <span style={{ color: SOL.cyan }}>2</span> ** attempt;{"\n"}
            {"  "}<span style={{ color: SOL.green }}>const</span> jitter = Math.random() * base;{"\n"}
            {"  "}<span style={{ color: SOL.green }}>return</span> Math.min(base + jitter, MAX_DELAY);{"\n"}
            {"}\n\n"}
            <span style={{ color: SOL.green }}>export const</span> MAX_ATTEMPTS = <span style={{ color: SOL.cyan }}>8</span>;{"\n"}
          </pre>
        </div>
        <span className="absolute top-3 right-3 rounded px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: "rgba(0,0,0,0.35)", color: SOL.base2 }}>Theo&apos;s screen</span>
      </div>
      <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ borderTop: hair }}>
        <span className="font-semibold" style={{ color: SOL.magenta }}>{CALL_ID}@0:25</span>
        <span style={{ color: SOL.base1 }}>screen</span>
        <span className="min-w-0" style={{ color: SOL.base01 }}><span style={{ color: SOL.green }}>Theo</span> {l.text}</span>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ */
/* 07: presence and walkie                                             */
/* ------------------------------------------------------------------ */

const WALL = [
  { p: PEOPLE[0], state: "active", size: 54 },
  { p: PEOPLE[1], state: "active", size: 54 },
  { p: PEOPLE[2], state: "idle", size: 42 },
  { p: { id: "sam", name: "Sam", initials: "S", color: SOL.orange }, state: "away", size: 32 },
  { p: { id: "lee", name: "Lee", initials: "L", color: SOL.cyan }, state: "offline", size: 26 },
] as const;

/** The people wall: faces sized by presence, one opened to its actions. */
export function PeopleWall() {
  return (
    <Frame className="h-full" label="The people wall: each teammate's face sized by how present they are, with Talk, Ring and Message under the selected face">
      <div className="px-4 py-2.5 text-[12px] flex items-center" style={{ borderBottom: hair, color: SOL.base02 }}>
        People <span className="ml-auto text-[10.5px]" style={{ color: SOL.base1 }}>sized by presence</span>
      </div>
      <div className="px-5 py-6 flex flex-wrap items-end justify-center gap-5">
        {WALL.map(({ p, state, size }) => (
          <div key={p.id} className="flex flex-col items-center gap-1.5" style={{ opacity: state === "offline" ? 0.45 : 1 }}>
            <span className="relative">
              <Face p={p} size={size} ring={p.id === "theo" ? SOL.magenta : undefined} />
              <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full" style={{ backgroundColor: state === "active" ? SOL.green : state === "idle" ? SOL.yellow : SOL.base1, boxShadow: "0 0 0 2px #fffaf0" }} />
            </span>
            <span className="text-[10.5px]" style={{ color: SOL.base01 }}>{p.name}</span>
            <span className="text-[9.5px]" style={{ color: SOL.base1 }}>{state}</span>
          </div>
        ))}
      </div>
      <div className="mx-4 mb-4 rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-2 text-[11.5px]" style={{ border: hair, backgroundColor: "#fdf6e3" }}>
        <Face p={PEOPLE[1]} size={20} />
        <span style={{ color: SOL.base02 }}>Theo</span>
        <span className="ml-auto flex gap-1.5">
          {["Talk", "Ring", "Message"].map((a, i) => (
            <span key={a} className="rounded-md px-2 py-1" style={{ backgroundColor: i === 0 ? SOL.magenta : SOL.base2, color: i === 0 ? "#fff" : SOL.base02 }}>{a}</span>
          ))}
        </span>
      </div>
    </Frame>
  );
}

/** A walkie burst landing in a DM: live words, then the voice recording. */
export function WalkieBurst() {
  return (
    <Frame className="h-full" label="A walkie burst in a DM: the words appear while they are spoken and the message lands with the voice recording">
      <div className="px-4 py-2.5 text-[12px] flex items-center gap-2" style={{ borderBottom: hair, color: SOL.base02 }}>
        <Face p={PEOPLE[2]} size={18} /> Priya
        <span className="ml-auto flex items-center gap-1 text-[10.5px]" style={{ color: SOL.base1 }}>
          Talk <KeyCap size="xs">Ctrl</KeyCap><KeyCap size="xs">Shift</KeyCap><KeyCap size="xs">Space</KeyCap>
        </span>
      </div>
      <div className="px-4 py-4 space-y-3">
        <div className="flex gap-2.5">
          <Face p={PEOPLE[2]} size={22} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-semibold" style={{ color: SOL.violet }}>Priya</span>
              <span className="flex items-center gap-1 rounded-full px-1.5 text-[9.5px]" style={{ backgroundColor: "rgba(220,50,47,0.1)", color: SOL.red }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.red }} /> talking
              </span>
            </div>
            <div className="mt-1 text-[12.5px] leading-snug" style={{ color: SOL.base02 }}>
              the note is drafted, can you check the numbers before I send it<span className="cc-caret ml-0.5 inline-block h-3.5 w-[2px] align-middle" style={{ backgroundColor: SOL.violet }} />
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-full px-2.5 py-1.5 w-fit" style={{ backgroundColor: SOL.base2 }}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={SOL.base02}><path d="M8 5v14l11-7z" /></svg>
              <span className="cc-talking flex items-center gap-[2px] h-4">
                {[0.4, 0.8, 0.55, 1, 0.65, 0.9, 0.5, 0.75, 0.45, 0.85, 0.6, 0.35].map((h, i) => (
                  <span key={i} className="w-[3px] rounded-full" style={{ height: `${h * 100}%`, backgroundColor: SOL.violet, "--i": i } as CSSProperties} />
                ))}
              </span>
              <span className="text-[10.5px]" style={{ color: SOL.base01 }}>0:06</span>
            </div>
          </div>
        </div>
        <div className="flex justify-end">
          <span className="rounded-md px-2.5 py-1 text-[11px]" style={{ border: `1px solid ${SOL.magenta}`, color: SOL.magenta }}>Join live</span>
        </div>
      </div>
    </Frame>
  );
}
