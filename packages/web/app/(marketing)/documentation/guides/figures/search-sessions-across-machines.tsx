"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Arrow, Sheet } from "../figureParts";

/**
 * Figures for searching session history across machines: local search
 * against one synced history, and the scopes a codecast search covers.
 */

const MACHINES = [
  { name: "laptop", agents: "Claude Code, Codex" },
  { name: "desktop", agents: "Claude Code, Cursor" },
  { name: "cloud box", agents: "Claude Code, Gemini" },
];

function Machine({ x, y, name, sub, at, dim, badge }: { x: number; y: number; name: string; sub: string; at: number; dim?: boolean; badge?: string }) {
  return (
    <g className="bj-pop" style={t(at)} opacity={dim ? 0.45 : 1}>
      <rect x={x} y={y} width={150} height={52} rx={7} fill={SOL.base3} stroke={dim ? SOL.base2 : SOL.base1} />
      <text x={x + 10} y={y + 19} fontSize="11" fontWeight={700} fill={SOL.base02}>{name}</text>
      <text x={x + 10} y={y + 36} fontSize="9.5" fill={SOL.base01}>{sub}</text>
      {badge && (
        <g>
          <rect x={x + 96} y={y + 8} width={46} height={16} rx={8} fill={`${SOL.cyan}22`} />
          <text x={x + 119} y={y + 19.5} textAnchor="middle" fontSize="9" fill={SOL.cyan}>{badge}</text>
        </g>
      )}
    </g>
  );
}

/** Local tools search the files on the machine in front of you; the codecast
 *  daemon on each machine syncs into one history every machine searches. */
export function OneHistoryFigure() {
  const ys = [26, 96, 166];
  return (
    <Stage>
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Search where the files sit" sub="claude --resume, search-sessions and LLMnesia read this machine's disk." color={SOL.base1} />
          <Sheet w={380} h={240} label="A local search reaches only the laptop's session files">
            {(arrow) => (
              <>
                {MACHINES.map((m, i) => (
                  <Machine key={m.name} x={200} y={ys[i]} name={m.name} sub="~/.claude/projects" at={0.2 + i * 0.15} dim={i > 0} />
                ))}
                <g className="bj-pop" style={t(0.8)}>
                  <rect x={20} y={30} width={130} height={44} rx={8} fill={SOL.base03} />
                  <text x={85} y={50} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.base3}>local search</text>
                  <text x={85} y={65} textAnchor="middle" fontSize="9.5" fill={SOL.base1}>on the laptop</text>
                </g>
                <Arrow head={arrow()} d="M152 52H194" at={1.0} />
                <path d="M30 76V214" stroke={SOL.red} strokeWidth={1.2} strokeDasharray="3 4" className="bj-fade" style={t(1.4)} />
                <text x={42} y={118} fontSize="10" fill={SOL.red} className="bj-fade" style={t(1.5)}>
                  <tspan x={42}>other machines:</tspan>
                  <tspan x={42} dy={13}>not reachable</tspan>
                  <tspan x={42} dy={13}>without copying</tspan>
                  <tspan x={42} dy={13}>their files over</tspan>
                </text>
              </>
            )}
          </Sheet>
        </div>
        <div>
          <PanelHead title="Sync, then search one history" sub="A daemon on each machine syncs every session as it is written." color={SOL.cyan} />
          <Sheet w={380} h={240} label="Daemons on three machines sync Claude Code, Codex, Cursor and Gemini sessions into one history searched from any machine or the web">
            {(arrow) => (
              <>
                {MACHINES.map((m, i) => (
                  <Machine key={m.name} x={14} y={ys[i]} name={m.name} sub={m.agents} at={0.2 + i * 0.15} badge="daemon" />
                ))}
                {ys.map((y, i) => (
                  <Arrow key={y} head={arrow()} d={`M166 ${y + 26}C196 ${y + 26} 196 118 222 118`} at={0.9 + i * 0.12} color={SOL.cyan} />
                ))}
                <g className="bj-pop" style={t(1.4)}>
                  <rect x={228} y={88} width={138} height={60} rx={8} fill={SOL.base03} />
                  <text x={297} y={112} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.base3}>one history</text>
                  <text x={297} y={128} textAnchor="middle" fontSize="9.5" fill={SOL.base1}>your account + team</text>
                </g>
                <Arrow head={arrow()} d="M297 150V180" at={1.7} />
                <text x={297} y={198} textAnchor="middle" fontSize="10" fontWeight={700} fill={SOL.cyan} className="bj-fade" style={t(1.9)}>cast search, cast ask</text>
                <text x={297} y={213} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(2.0)}>from any machine, or</text>
                <text x={297} y={227} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(2.0)}>codecast.sh/search</text>
              </>
            )}
          </Sheet>
        </div>
      </div>
    </Stage>
  );
}

// ─── Scopes ────────────────────────────────────────────────────────────────

const RINGS = [
  { r: 112, label: "-g", sub: "every team you belong to", color: SOL.violet },
  { r: 78, label: "default", sub: "what your team can see in this directory's project", color: SOL.cyan },
  { r: 40, label: "--mine", sub: "only your own sessions", color: SOL.blue },
];

const FILTERS = [
  { flag: "-m samvit", what: "one teammate's sessions" },
  { flag: "-s 7d", what: "only the last seven days" },
  { flag: "-u", what: "only lines a person typed" },
  { flag: '"rate limit"', what: "quoted: the exact phrase" },
];

/** The rings choose whose sessions a search covers; the flags beside them
 *  narrow any ring further. */
export function SearchScopeFigure() {
  const cx = 140;
  const cy = 150;
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={320} label="Search scopes nest: --mine inside the default team scope inside -g; filters narrow by member, time, typed lines and exact phrase">
        {RINGS.map((ring, i) => (
          <circle key={ring.label} cx={cx} cy={cy} r={ring.r} fill={`${ring.color}${i === 1 ? "22" : "14"}`} stroke={ring.color} strokeWidth={i === 1 ? 1.8 : 1.2} strokeDasharray={i === 0 ? "4 4" : undefined} className="bj-pop" style={t(0.2 + i * 0.3)} />
        ))}
        {RINGS.map((ring, i) => {
          const y = 40 + i * 52;
          return (
            <g key={`l${ring.label}`} className="bj-rise" style={t(0.5 + i * 0.3)}>
              <path d={`M${cx + ring.r * 0.72} ${cy - ring.r * 0.69}L292 ${y - 4}H306`} stroke={ring.color} strokeWidth={1} fill="none" />
              <text x={312} y={y} fontSize="12" fontWeight={700} fill={ring.color}>{ring.label}</text>
              <text x={312} y={y + 15} fontSize="10.5" fill={SOL.base01}>{ring.sub}</text>
            </g>
          );
        })}
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fill={SOL.base02} className="bj-fade" style={t(1.1)}>you</text>

        <g className="bj-fade" style={t(1.4)}>
          <text x={312} y={196} fontSize="11" fontWeight={700} fill={SOL.base02}>then narrow any ring</text>
        </g>
        {FILTERS.map((f, i) => (
          <g key={f.flag} className="bj-rise" style={t(1.6 + i * 0.15)}>
            <rect x={312} y={206 + i * 26} width={110} height={20} rx={4} fill={SOL.base3} stroke={SOL.base2} />
            <text x={367} y={220 + i * 26} textAnchor="middle" fontSize="10" fontWeight={700} fill={SOL.base02}>{f.flag}</text>
            <text x={432} y={220 + i * 26} fontSize="10" fill={SOL.base01}>{f.what}</text>
          </g>
        ))}
      </Sheet>
    </Stage>
  );
}
