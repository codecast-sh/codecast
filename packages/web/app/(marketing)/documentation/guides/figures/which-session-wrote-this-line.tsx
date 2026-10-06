"use client";

import type { ReactNode } from "react";
import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Grid } from "./shared/svg";

/**
 * Figures for the cast blame guide: how each line's commit is matched to a
 * session, and how the session trailer gets into a commit.
 */

// ─── Resolving lines to sessions ───────────────────────────────────────────

const CHECKS = [
  { label: "trailer", sub: "Codecast-Session" },
  { label: "commit record", sub: "hash codecast saw" },
  { label: "edit's hash", sub: "hash in an edit" },
  { label: "subject + time", sub: "after a rewrite" },
  { label: "content", sub: "recent agent edits" },
];

const LINES = [
  { n: "12", kind: "committed by an agent", hit: 0, who: "jx74qbm", color: SOL.cyan },
  { n: "42", kind: "rebased since", hit: 3, who: "jx74qbm", color: SOL.cyan },
  { n: "57", kind: "not committed yet", hit: 4, who: "jx7d2ui", color: SOL.violet },
  { n: "60", kind: "typed by hand", hit: -1, who: "git author", color: SOL.base1 },
];

/** Each line's commit falls through the checks until one names a session.
 *  Uncommitted lines go straight to the content match. */
export function BlameCascadeFigure() {
  const X0 = 190;
  const CW = 104;
  const cx = (i: number) => X0 + i * CW + CW / 2;
  const rowY = (i: number) => 104 + i * 44;
  const STEP = 0.32;
  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 760 330" className="w-full block font-mono" role="img" aria-label="Lines fall through trailer, commit record, edit hash, subject and time, and content checks until one names a session; a line no session touched keeps its git author">
        <Grid id="wsl-c" w={760} h={330} />
        <text x={20} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>git blame, locally</text>
        <text x={20} y={46} fontSize="10" fill={SOL.base01}>the commit behind each line</text>
        <text x={X0} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>codecast tries, in order</text>

        {CHECKS.map((c, i) => (
          <g key={c.label} className="bj-pop" style={t(0.15 + i * 0.1)}>
            <rect x={X0 + i * CW + 4} y={50} width={CW - 8} height={38} rx={6} fill={i === 4 ? `${SOL.violet}14` : SOL.base3} stroke={i === 4 ? SOL.violet : SOL.base1} />
            <text x={cx(i)} y={66} textAnchor="middle" fontSize="10.5" fontWeight={700} fill={SOL.base02}>{c.label}</text>
            <text x={cx(i)} y={80} textAnchor="middle" fontSize="8.5" fill={SOL.base01}>{c.sub}</text>
            <line x1={cx(i)} x2={cx(i)} y1={90} y2={rowY(LINES.length - 1) + 8} stroke={SOL.base2} strokeDasharray="2 3" />
          </g>
        ))}

        {LINES.map((l, li) => {
          const y = rowY(li);
          const start = 0.8 + li * 0.55;
          const first = l.hit === 4 ? 4 : 0;
          const last = l.hit === -1 ? 3 : l.hit;
          const end = l.hit === -1 ? X0 + 5 * CW - 44 : cx(l.hit);
          return (
            <g key={l.n}>
              <g className="bj-rise" style={t(start)}>
                <text x={20} y={y + 4} fontSize="11" fontWeight={700} fill={SOL.base02}>{`line ${l.n}`}</text>
                <text x={20} y={y + 18} fontSize="9.5" fill={SOL.base01}>{l.kind}</text>
              </g>
              <path d={`M${X0 - 14} ${y}H${end}`} pathLength={1} stroke={l.color} strokeWidth={1.5} fill="none" className="bj-draw" style={t(start + 0.1, STEP * (last - first + 1))} />
              {CHECKS.map((_, ci) => ci >= first && ci < (l.hit === -1 ? 4 : l.hit) && (
                <circle key={ci} cx={cx(ci)} cy={y} r={3} fill={SOL.base3} stroke={SOL.base1} className="bj-pop" style={t(start + 0.1 + STEP * (ci - first + 0.6))} />
              ))}
              {l.hit >= 0 ? (
                <g className="bj-pop" style={t(start + 0.1 + STEP * (last - first + 1))}>
                  <rect x={cx(l.hit) - 32} y={y - 10} width={64} height={20} rx={10} fill={l.color} />
                  <text x={cx(l.hit)} y={y + 4} textAnchor="middle" fontSize="10" fontWeight={700} fill={SOL.base3}>{l.who}</text>
                </g>
              ) : (
                <text x={X0 + 5 * CW - 38} y={y + 4} fontSize="10" fill={SOL.base1} className="bj-fade" style={t(start + 1.5)}>git author</text>
              )}
            </g>
          );
        })}

        <g className="bj-fade" style={t(3.4)}>
          <line x1={20} x2={740} y1={282} y2={282} stroke={SOL.base2} />
          <text x={20} y={304} fontSize="10.5" fill={SOL.base01}>
            <tspan fontWeight={700} fill={SOL.base02}>When two answers apply: </tspan>
            the session that wrote the line beats the session that committed it,
          </text>
          <text x={20} y={320} fontSize="10.5" fill={SOL.base01}>which beats the git author. A trailer counts only for someone who can read that session.</text>
        </g>
      </svg>
    </Stage>
  );
}

// ─── The trailer ───────────────────────────────────────────────────────────

function Code({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <pre className="mx-4 mb-4 p-3 rounded-lg font-mono text-[11px] leading-[1.75] whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ backgroundColor: SOL.base03, color: dim ? SOL.base1 : SOL.base2 }}>
      {children}
    </pre>
  );
}

const SESSION_URL = "https://codecast.sh/conversation/jx74qbm…";

/** The hook rewrites the agent's commit command before it runs; the link then
 *  lives in the commit message, which git carries through history rewrites. */
export function TrailerFigure() {
  return (
    <Stage>
      <div className="grid md:grid-cols-3">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="The agent runs" sub="An ordinary commit from Claude Code's Bash tool." color={SOL.base1} />
          <div className="bj-rise" style={t(0.2)}>
            <Code>git commit -m "fix: refresh the token before it expires"</Code>
          </div>
        </div>
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="The hook rewrites it" sub="Before the command runs; the permission decision is left as it was." color={SOL.cyan} />
          <div className="bj-rise" style={t(0.9)}>
            <Code>
              git commit{" "}
              <span className="bj-fade rounded px-0.5" style={{ ...t(1.4), backgroundColor: `${SOL.cyan}33`, color: SOL.base3 }}>
                --trailer 'Codecast-Session: {SESSION_URL}'
              </span>{" "}
              -m "fix: refresh the token before it expires"
            </Code>
          </div>
          <div className="px-5 pb-4 -mt-1 text-[11.5px] leading-snug bj-fade" style={{ ...t(1.8), color: SOL.base01 }}>
            Skipped when the session is private to you, or when <code className="font-mono">codecast.sessionTrailer</code> is false.
          </div>
        </div>
        <div>
          <PanelHead title="The commit carries it" sub="Through rebase, squash and any git host." color={SOL.green} />
          <div className="bj-rise" style={t(2.2)}>
            <Code>
              <span style={{ color: SOL.yellow }}>commit 9f3c2e1</span>
              {"\n\n    fix: refresh the token before it expires\n\n    "}
              <span style={{ color: SOL.cyan }}>Codecast-Session: {SESSION_URL}</span>
            </Code>
          </div>
          <div className="px-5 pb-4 -mt-1 text-[11.5px] leading-snug bj-fade" style={{ ...t(2.7), color: SOL.base01 }}>
            <code className="font-mono">git log</code> alone leads back to the conversation; opening it still needs access.
          </div>
        </div>
      </div>
    </Stage>
  );
}
