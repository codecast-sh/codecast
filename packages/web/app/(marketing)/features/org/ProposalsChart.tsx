"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Person, SessionDot, Tile } from "./kit";
import { DIM, INK, LINE, MUTED, SOL, TEXT, person, role, tint } from "./model";
import { GHOST_EDGE, GHOST_FILL, VIOLET, type Sid, type State } from "./proposalsData";
import type { IconKey } from "./icons";

/*
 * The chart beside op-7, cut to what the proposal touches: Maya, the two
 * leads it changes, the proposed Head of Platform, Release Captain, Social
 * lead and the sessions being filed; the untouched roles fold into one stub.
 * A proposed role is a violet ghost labelled "proposed"; a move stands at its
 * new place with "was under"; an area change is a quiet violet line. On send
 * an applied ghost solidifies (tile pops, line draws) and a rejected one
 * fades out. `lit` is the subject hovered in the proposal.
 */

const W = 480;
const H = 420;
const MAYA = { x: 240, y: 8, w: 184, h: 50 };
const LEAD_Y = 100;
const LEAD_H = 118;
const SUB_Y = 270;
const LEADS = { eng: 66, growth: 188, rest: 290, platform: 404 } as const;
const SUBS = { release: 66, social: 188, releaseNew: 346, cluster: 440 } as const;
const OTHER_ROLES: IconKey[] = ["org chart", "cloud", "smartphone", "lab flask", "ad click", "customer check"];

type Mode = "solid" | "ghost" | "gone";
const elbow = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} V${(y1 + y2) / 2} H${x2} V${y2}`;

function Box({ x, y, w, mode = "solid", lit, land, children, style }: { x: number; y: number; w: number; mode?: Mode; lit?: boolean; land?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div key={land} className={`og-prop-node absolute ${land ? "og-prop-land" : ""}`} data-mode={mode} style={{ left: x - w / 2, top: y, width: w, ...style }}>
      <div className="rounded-xl h-full" style={{ transition: "box-shadow .2s ease", boxShadow: lit ? `0 0 0 2px ${tint(VIOLET, 60)}, 0 0 0 6px ${tint(VIOLET, 14)}` : "none" }}>
        {children}
      </div>
    </div>
  );
}

/** A role on the chart: tile over its name, in a card for a lead and bare for a report. */
function Node({ k, title, sub, line, mode = "solid", card, land }: { k: IconKey; title: string; sub?: ReactNode; line?: ReactNode; mode?: Mode; card?: boolean; land?: string }) {
  const ghost = mode === "ghost";
  const framed = card || ghost;
  return (
    <div
      className="h-full flex flex-col items-center text-center rounded-xl px-2 py-2.5"
      style={{
        borderWidth: 1, borderStyle: "solid",
        borderColor: ghost ? GHOST_EDGE : framed ? LINE : "transparent",
        backgroundColor: ghost ? GHOST_FILL : framed ? "#fffdf6" : "transparent",
        boxShadow: framed && !ghost ? "0 12px 26px -20px rgba(0,43,54,.5)" : "none",
        transition: "border-color .4s ease, background-color .4s ease",
      }}
    >
      <Tile k={k} size={30} className={land ? "og-anim og-pop" : ""} style={{ opacity: ghost ? 0.55 : 1, transition: "opacity .4s ease" }} />
      <div className="mt-1.5 font-mono font-bold text-[12px] leading-[15px]" style={{ color: ghost ? VIOLET : INK }}>{title}</div>
      {sub && <div className="mt-0.5 font-mono text-meta leading-[14px]" style={{ color: ghost ? tint(VIOLET, 80) : DIM }}>{sub}</div>}
      {line && <div className="mt-1 font-mono text-meta leading-[14px]">{line}</div>}
    </div>
  );
}

/** Drawn at W x H and scaled to the column, never below its own size on a phone (the frame scrolls there). */
function Scaled({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1);
  const measure = (el: HTMLDivElement | null) => {
    if (!el) return;
    const read = () => setScale(Math.min(1.3, Math.max(1, el.clientWidth / W)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  };
  return (
    <div ref={measure} className="relative w-full" style={{ minWidth: W, height: H * scale }}>
      <div className="absolute left-0 top-0" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0" }}>{children}</div>
    </div>
  );
}

export function ProposalsChart({ state, lit }: { state: State; lit: Sid | null }) {
  const { outcome, revised, sends } = state;
  const maya = person("maya");
  const pMode: Mode = outcome.platform === "applied" ? "solid" : outcome.platform === "rejected" ? "gone" : "ghost";
  const landKey = (id: Sid) => (outcome[id] === "applied" ? `land-${sends}-${id}` : undefined);
  const platformLand = landKey("platform");

  // The move: Release stands under Platform while proposed or applied.
  const moved = !revised && outcome.move !== "rejected";
  const moveMode: Mode = moved && outcome.move !== "applied" ? "ghost" : "solid";
  const routine = revised && outcome.move !== "rejected";
  const fMode: Mode = pMode === "gone" || outcome.filing === "rejected" ? "gone" : outcome.filing === "applied" ? "solid" : "ghost";

  const grey = SOL.base1;
  const proposedInk = tint(VIOLET, 55);
  const top = MAYA.y + MAYA.h;
  const bottom = LEAD_Y + LEAD_H;
  const lines: { id: string; d: string; color: string; hidden?: boolean; draw?: string }[] = [
    { id: "eng", d: elbow(MAYA.x, top, LEADS.eng, LEAD_Y), color: grey },
    { id: "growth", d: elbow(MAYA.x, top, LEADS.growth, LEAD_Y), color: grey },
    { id: "rest", d: elbow(MAYA.x, top, LEADS.rest, LEAD_Y + 20), color: tint(grey, 55) },
    { id: "platform", d: elbow(MAYA.x, top, LEADS.platform, LEAD_Y), color: pMode === "ghost" ? proposedInk : grey, hidden: pMode === "gone", draw: platformLand },
    { id: "social", d: elbow(LEADS.growth, bottom, SUBS.social, SUB_Y), color: grey },
    moved
      ? { id: "release-new", d: elbow(LEADS.platform, bottom, SUBS.releaseNew, SUB_Y), color: moveMode === "ghost" ? proposedInk : grey, hidden: pMode === "gone", draw: landKey("move") }
      : { id: "release", d: elbow(LEADS.eng, bottom, SUBS.release, SUB_Y), color: grey },
    { id: "cluster", d: elbow(LEADS.platform, bottom, SUBS.cluster, SUB_Y + 8), color: fMode === "ghost" ? proposedInk : grey, hidden: fMode === "gone", draw: landKey("filing") },
  ];

  const violet = (t: ReactNode) => <span style={{ color: VIOLET }}>{t}</span>;
  const quiet = (t: ReactNode) => <span style={{ color: MUTED }}>{t}</span>;
  return (
    <Scaled>
      <svg className="absolute inset-0" width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden>
        {lines.map((l) => (
          <path key={l.draw ?? l.id} d={l.d} pathLength={1} className={`og-prop-line ${l.draw ? "og-anim og-draw" : ""}`} stroke={l.color} strokeWidth={1.5} style={{ opacity: l.hidden ? 0 : 1 }} />
        ))}
      </svg>

      <Box x={MAYA.x} y={MAYA.y} w={MAYA.w}>
        <div className="rounded-xl border px-3 py-2 flex items-center gap-2.5" style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 12px 26px -20px rgba(0,43,54,.5)" }}>
          <Person p={maya} size={32} />
          <div className="min-w-0">
            <div className="font-mono font-bold text-[13px] leading-tight" style={{ color: INK }}>{maya.name}</div>
            <div className="font-mono text-meta" style={{ color: DIM }}>founder · {pMode === "solid" ? 4 : 3} leads</div>
          </div>
        </div>
      </Box>

      <Box x={LEADS.eng} y={LEAD_Y} w={116} style={{ height: LEAD_H }}>
        <Node card k="terminal window" title={role("eng").title} sub="@eng" line={quiet(moved && moveMode === "solid" ? "3 reports" : "4 reports")} />
      </Box>
      <Box x={LEADS.growth} y={LEAD_Y} w={116} style={{ height: LEAD_H }} lit={lit === "area"}>
        <Node card k="billboard" title={role("growth").title} sub="@cmo" line={outcome.area === "applied" ? quiet("+ Pricing page") : outcome.area ? undefined : violet("+ Pricing page")} />
      </Box>

      {/* The roles op-7 leaves alone, folded into one stub. */}
      <Box x={LEADS.rest} y={LEAD_Y + 20} w={72}>
        <div className="rounded-xl border px-2 py-2 flex flex-col items-center" style={{ borderColor: tint(LINE, 70), backgroundColor: "rgba(255,253,246,.7)" }}>
          <div className="grid grid-cols-3 gap-[3px]" style={{ opacity: 0.55 }}>
            {OTHER_ROLES.map((k) => <Tile key={k} k={k} size={14} />)}
          </div>
          <div className="mt-1.5 font-mono text-meta" style={{ color: MUTED }}>+{OTHER_ROLES.length} roles</div>
        </div>
      </Box>

      <Box x={LEADS.platform} y={LEAD_Y} w={128} style={{ height: LEAD_H }} mode={pMode} lit={lit === "platform" || (lit === "move" && revised)} land={platformLand}>
        <Node
          card k="server rack" title="Head of Platform" mode={pMode} land={platformLand}
          sub={pMode === "ghost" ? "proposed" : "@platform"}
          line={routine
            ? (outcome.move === "applied" ? quiet("Release check · daily") : violet("+ Release check daily"))
            : pMode === "ghost" ? violet("14 sessions") : quiet("14 sessions")}
        />
      </Box>

      <Box x={SUBS.social} y={SUB_Y} w={104} lit={lit === "filing"}>
        <Node k="share nodes" title="Social lead" sub="@social" line={fMode === "gone" ? undefined : fMode === "ghost" ? violet("+3 sessions") : quiet("3 filed here")} />
      </Box>

      <Box x={moved ? SUBS.releaseNew : SUBS.release} y={SUB_Y} w={104} mode={moved && pMode === "gone" ? "gone" : "solid"} lit={lit === "move" && !revised} land={landKey("move")}>
        <Node
          k="rocket launch" title="Release Captain" mode={moveMode} sub="@release"
          line={moved ? (moveMode === "ghost" ? violet("was under @eng") : quiet("moved from @eng")) : undefined}
        />
      </Box>

      <Box x={SUBS.cluster} y={SUB_Y + 8} w={76} mode={fMode} lit={lit === "filing"} land={landKey("filing")}>
        <div className="rounded-xl px-2 py-2.5 text-center" style={{ backgroundColor: fMode === "ghost" ? GHOST_FILL : "#fffdf6", boxShadow: `inset 0 0 0 1px ${fMode === "ghost" ? GHOST_EDGE : LINE}` }}>
          <div className="flex justify-center gap-[3px] flex-wrap">
            {Array.from({ length: 7 }, (_, i) => <SessionDot key={i} state={i < 2 ? "needs" : i < 5 ? "working" : "dormant"} size={8} />)}
          </div>
          <div className="mt-1.5 font-mono text-meta font-semibold" style={{ color: fMode === "ghost" ? VIOLET : TEXT }}>+7 sessions</div>
        </div>
      </Box>
    </Scaled>
  );
}
