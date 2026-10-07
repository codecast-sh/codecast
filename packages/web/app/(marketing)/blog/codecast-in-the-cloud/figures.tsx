"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../blogChrome";
import { FigureStyles, PanelHead, Stage, t } from "../figureKit";

/**
 * Illustrations for "Codecast in the cloud", built on the shared figure kit
 * (../figureKit.tsx): each plays once when it scrolls into view. The laptop is
 * always paper and the host is always night, so a reader can tell at a glance
 * which machine a thing lives on.
 */

export { FigureStyles };

const NIGHT = "#01232c";
const NIGHT_LINE = "#0b4a5a";
const PAPER = "#fffbf0";
const PAPER_LINE = "#e3dcc6";

/** An arrowhead pointing `dir` with its tip at (x, y). */
function Head({ x, y, dir, color, style }: { x: number; y: number; dir: "l" | "r" | "u" | "d"; color: string; style?: CSSProperties }) {
  const d = {
    r: `M${x} ${y}l-7 -4v8z`,
    l: `M${x} ${y}l7 -4v8z`,
    d: `M${x} ${y}l-4 -7h8z`,
    u: `M${x} ${y}l-4 7h8z`,
  }[dir];
  return <path d={d} fill={color} className="bj-pop" style={style} />;
}

// ─── Figure 1: the map ─────────────────────────────────────────────────────

const LANES: { y: number; name: string; what: string; way: "out" | "both"; color: string }[] = [
  { y: 92, name: "cast spawn --cloud", what: "your checkout, uncommitted work included", way: "out", color: SOL.blue },
  { y: 136, name: "home mirror", what: "agent config, instructions, memory", way: "both", color: SOL.cyan },
  { y: 180, name: "logins", what: "one way; the laptop stays the source", way: "out", color: SOL.yellow },
  { y: 224, name: "live sync", what: "every 3 s while the agent works", way: "both", color: SOL.green },
  { y: 268, name: "cast migrate", what: "running sessions, messages held", way: "both", color: SOL.orange },
  { y: 312, name: "browser sync · reach · vnc", what: "a site's login, a folder, the screen", way: "both", color: SOL.magenta },
];

export function MapFigure() {
  const L = 196;
  const R = 524;
  return (
    <Stage minWidth={640}>
      <svg viewBox="0 0 720 470" className="w-full block font-mono" role="img" aria-label="What moves between a laptop and a cloud host">
        <rect x={16} y={56} width={180} height={284} rx={12} fill={PAPER} stroke={PAPER_LINE} className="bj-fade" style={t(0)} />
        <text x={106} y={82} textAnchor="middle" fontSize="13" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(0)}>your laptop</text>
        <text x={106} y={100} textAnchor="middle" fontSize="10" fill={SOL.base1} className="bj-fade" style={t(0)}>MacBook-Pro</text>
        {["the checkout you are in", "your logins, keychain", "the host registry", "your Chrome", "your SSH keys"].map((s, i) => (
          <text key={s} x={30} y={150 + i * 34} fontSize="10.5" fill={SOL.base01} className="bj-rise" style={t(0.2 + i * 0.08)}>{s}</text>
        ))}

        <rect x={524} y={56} width={180} height={284} rx={12} fill={NIGHT} stroke={NIGHT_LINE} className="bj-fade" style={t(0.1)} />
        <text x={614} y={82} textAnchor="middle" fontSize="13" fontWeight={700} fill={SOL.base2} className="bj-fade" style={t(0.1)}>your cloud host</text>
        <text x={614} y={100} textAnchor="middle" fontSize="10" fill={SOL.base01} className="bj-fade" style={t(0.1)}>EC2, your AWS account</text>
        {["one worktree per task", "the codecast daemon", "agents in tmux", "Chrome on Xvfb :99", "an idle watchdog"].map((s, i) => (
          <text key={s} x={538} y={150 + i * 34} fontSize="10.5" fill={SOL.base0} className="bj-rise" style={t(0.3 + i * 0.08)}>{s}</text>
        ))}

        {LANES.map((l, i) => {
          const at = 0.8 + i * 0.35;
          return (
            <g key={l.name}>
              <text x={(L + R) / 2} y={l.y - 8} textAnchor="middle" fontSize="11" fontWeight={700} fill={l.color} className="bj-fade" style={t(at)}>{l.name}</text>
              <path d={`M${L + 6} ${l.y}H${R - 6}`} pathLength={1} stroke={l.color} strokeWidth={1.6} fill="none" className="bj-draw" style={t(at, 0.45)} />
              <Head x={R - 4} y={l.y} dir="r" color={l.color} style={t(at + 0.45)} />
              {l.way === "both" && <Head x={L + 4} y={l.y} dir="l" color={l.color} style={t(at + 0.45)} />}
              <text x={(L + R) / 2} y={l.y + 16} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(at + 0.2)}>{l.what}</text>
            </g>
          );
        })}

        <rect x={262} y={396} width={196} height={50} rx={10} fill={SOL.base2} className="bj-pop" style={t(3.1)} />
        <text x={360} y={417} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(3.1)}>codecast</text>
        <text x={360} y={433} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(3.1)}>inbox, commands, tokens</text>
        <path d="M106 340V421H262" pathLength={1} fill="none" stroke={SOL.base1} strokeDasharray="0" strokeWidth={1.3} className="bj-draw" style={t(3.3, 0.5)} />
        <path d="M614 340V421H458" pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.3} className="bj-draw" style={t(3.3, 0.5)} />
        <text x={116} y={384} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(3.7)}>the laptop does the work</text>
        <text x={604} y={384} textAnchor="end" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(3.7)}>the host asks for it</text>
        <text x={360} y={30} textAnchor="middle" fontSize="10" fill={SOL.base1} className="bj-fade" style={t(0)}>files and logins ride SSH from the laptop; codecast carries commands and short-lived tokens</text>
      </svg>
    </Stage>
  );
}

// ─── Figure 2: what travels with a cloud spawn ────────────────────────────

const TRAVELS = [
  "your branch and unpushed commits",
  "uncommitted edits, staged or not",
  "untracked files",
  "gitignored files: .env.local and friends",
  "tracked files of any size",
];

const STAYS: [string, string][] = [
  ["node_modules, .venv, dist, target, Pods…", "rebuilt"],
  ["an untracked video or audio file", "media"],
  ["an untracked native binary ≥ 256 KB", "binary"],
  ["an untracked file over 100 MB", "large"],
  ["untracked files past 1 GB, largest first", "total"],
  ["sockets, pid files, database journals", "live"],
  ["a repository nested inside this one", "repo"],
];

export function TravelFigure() {
  return (
    <Stage>
      <div className="grid md:grid-cols-2 font-mono">
        <div className="pb-5 border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Travels" sub="Captured through a temporary git index, so nothing in your checkout moves." color={SOL.blue} />
          <ul className="px-5 mt-4 space-y-2.5">
            {TRAVELS.map((s, i) => (
              <li key={s} className="bj-rise flex gap-2.5 text-[13px] leading-snug" style={t(0.2 + i * 0.12, undefined, { color: SOL.base02 })}>
                <span style={{ color: SOL.blue }}>→</span>{s}
              </li>
            ))}
          </ul>
        </div>
        <div className="pb-5">
          <PanelHead title="Stays, with a reason" sub="Each skipped file is listed under the reason it stayed, so nothing vanishes quietly." color={SOL.base1} />
          <ul className="px-5 mt-4 space-y-2">
            {STAYS.map(([s, why], i) => (
              <li key={s} className="bj-rise flex items-baseline justify-between gap-3 text-[12.5px] leading-snug" style={t(0.9 + i * 0.1, undefined, { color: SOL.base01 })}>
                <span>{s}</span>
                <span className="shrink-0 text-[11px] px-1.5 py-px rounded" style={{ backgroundColor: SOL.base2, color: SOL.base00 }}>{why}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Stage>
  );
}

// ─── Figure 3: what the host is given before any session starts ────────────

const ARRIVAL: { step: string; detail: string; color: string }[] = [
  { step: "disk", detail: "refuses to start with under 1 GiB free", color: SOL.base1 },
  { step: "cast", detail: "brought to the laptop's version", color: SOL.base1 },
  { step: "[host] setup", detail: "packages, services, run commands; skipped when in step", color: SOL.violet },
  { step: "logins", detail: "Claude only while its token is live; never refreshed on the host", color: SOL.yellow },
  { step: "tools", detail: "agent CLIs, node, bun, gh, uv at your versions, no sudo", color: SOL.green },
  { step: "git", detail: "a credential helper that asks for one token per push", color: SOL.orange },
  { step: "home mirror", detail: "~/.claude, ~/.codex, CLAUDE.md, shell rc, memory", color: SOL.cyan },
];

const STAYS_HOME = ["ANTHROPIC_API_KEY", "~/.ssh", "keychains", "Google logins", "browser profiles"];

export function ArrivalFigure() {
  return (
    <Stage>
      <div className="p-5 font-mono" style={{ backgroundColor: NIGHT }}>
        <div className="text-[12px] mb-4" style={{ color: SOL.base01 }}>ip-172-31-40-243 · before the agent starts</div>
        <ol className="space-y-2">
          {ARRIVAL.map((a, i) => (
            <li key={a.step} className="bj-rise grid grid-cols-[22px_120px_1fr] gap-2 items-baseline text-[12.5px]" style={t(0.15 + i * 0.28)}>
              <span className="bj-pop inline-block" style={t(0.35 + i * 0.28, undefined, { color: SOL.green })}>✓</span>
              <span className="font-bold" style={{ color: a.color }}>{a.step}</span>
              <span style={{ color: SOL.base0 }}>{a.detail}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 pt-4 border-t text-[12px] flex flex-wrap items-center gap-2" style={{ borderColor: NIGHT_LINE }}>
          <span className="bj-fade" style={t(2.3, undefined, { color: SOL.base01 })}>stays on the laptop:</span>
          {STAYS_HOME.map((s, i) => (
            <span key={s} className="bj-pop px-2 py-0.5 rounded border" style={t(2.4 + i * 0.1, undefined, { borderColor: NIGHT_LINE, color: SOL.base1 })}>{s}</span>
          ))}
        </div>
      </div>
    </Stage>
  );
}

// ─── Figure 4: a push from the host ────────────────────────────────────────

export function GitFigure() {
  const cols = [
    { x: 90, name: "git on the host", color: SOL.base2, dark: true },
    { x: 280, name: "cast git-credential", color: SOL.base2, dark: true },
    { x: 470, name: "codecast", color: SOL.base02, dark: false },
    { x: 640, name: "GitHub App", color: SOL.base02, dark: false },
  ];
  const steps: { from: number; to: number; y: number; label: string; at: number }[] = [
    { from: 0, to: 1, y: 100, label: "credentials for github.com?", at: 0.4 },
    { from: 1, to: 2, y: 136, label: "a token for this repo", at: 1.0 },
    { from: 2, to: 3, y: 172, label: "may this person push?", at: 1.6 },
    { from: 3, to: 2, y: 208, label: "installation token, 1 repo", at: 2.2 },
    { from: 2, to: 1, y: 244, label: "expires within the hour", at: 2.8 },
    { from: 1, to: 0, y: 282, label: "handed over, never on disk", at: 3.4 },
  ];
  return (
    <Stage minWidth={620}>
      <svg viewBox="0 0 730 330" className="w-full block font-mono" role="img" aria-label="How the host gets a token to push">
        <rect x={14} y={14} width={346} height={34} rx={8} fill={NIGHT} />
        <text x={187} y={64} textAnchor="middle" fontSize="9" fill={SOL.base1}>on the host</text>
        <text x={555} y={64} textAnchor="middle" fontSize="9" fill={SOL.base1}>off the host</text>
        {cols.map((c, i) => (
          <g key={c.name}>
            <text x={c.x} y={35} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={c.dark ? SOL.base2 : SOL.base02} className="bj-fade" style={t(i * 0.08)}>{c.name}</text>
            <path d={`M${c.x} 72V310`} stroke={SOL.base2} strokeWidth={1.4} strokeDasharray="3 4" />
          </g>
        ))}
        {steps.map((s) => {
          const x1 = cols[s.from].x;
          const x2 = cols[s.to].x;
          const right = x2 > x1;
          const color = right ? SOL.blue : SOL.orange;
          const mid = (x1 + x2) / 2;
          return (
            <g key={s.label}>
              <path d={`M${x1 + (right ? 4 : -4)} ${s.y}H${x2 + (right ? -6 : 6)}`} pathLength={1} stroke={color} strokeWidth={1.6} fill="none" className="bj-draw" style={t(s.at, 0.4)} />
              <Head x={x2 + (right ? -3 : 3)} y={s.y} dir={right ? "r" : "l"} color={color} style={t(s.at + 0.4)} />
              <text x={mid} y={s.y - 7} textAnchor="middle" fontSize="10" fill={SOL.base01} className="bj-fade" style={t(s.at + 0.1)}>{s.label}</text>
            </g>
          );
        })}
      </svg>
    </Stage>
  );
}

// ─── Figure 5: thirty seconds of live sync ─────────────────────────────────

/** Seconds → x. Ticks every 3 s while the agent works; at 24 s it goes idle. */
const SX = (s: number) => 92 + s * 20;
const TICKS = [3, 6, 9, 12, 15, 18, 21, 24];

type Edit = { side: "host" | "laptop"; at: number; lands: number; file: string; held?: boolean };
const EDITS: Edit[] = [
  { side: "host", at: 1.4, lands: 3, file: "v1.ts" },
  { side: "host", at: 4.6, lands: 6, file: "v1.test.ts" },
  { side: "host", at: 10.2, lands: 12, file: "v1.ts" },
  { side: "laptop", at: 13.1, lands: 15, file: "README.md" },
  { side: "host", at: 19.0, lands: 21, file: "routes.ts", held: true },
  { side: "laptop", at: 19.6, lands: 21, file: "routes.ts", held: true },
  { side: "host", at: 19.8, lands: 21, file: "v2.ts" },
];

export function SyncFigure() {
  const HOST_Y = 70;
  const LAP_Y = 170;
  const timeScale = 0.16;
  return (
    <Stage minWidth={640}>
      <svg viewBox="0 0 760 250" className="w-full block font-mono" role="img" aria-label="Live sync ticks between host and laptop">
        <rect x={0} y={0} width={760} height={120} fill={NIGHT} />
        <text x={14} y={HOST_Y + 4} fontSize="11" fontWeight={700} fill={SOL.base2}>host</text>
        <text x={14} y={LAP_Y + 4} fontSize="11" fontWeight={700} fill={SOL.base02}>laptop</text>
        <path d={`M${SX(0)} ${HOST_Y}H${SX(32)}`} stroke={NIGHT_LINE} strokeWidth={2} />
        <path d={`M${SX(0)} ${LAP_Y}H${SX(32)}`} stroke={SOL.base2} strokeWidth={2} />

        {TICKS.map((s) => (
          <g key={s}>
            <path d={`M${SX(s)} ${HOST_Y - 16}V${LAP_Y + 16}`} stroke={SOL.base1} strokeOpacity={0.45} strokeDasharray="2 3" className="bj-fade" style={t(s * timeScale)} />
            <text x={SX(s)} y={LAP_Y + 34} textAnchor="middle" fontSize="9.5" fill={SOL.base1}>{s}s</text>
          </g>
        ))}
        {[27, 30].map((s) => (
          <path key={s} d={`M${SX(s)} ${LAP_Y - 7}V${LAP_Y + 7}`} stroke={SOL.base1} strokeOpacity={0.5} className="bj-fade" style={t(s * timeScale)} />
        ))}

        {EDITS.map((e, i) => {
          const from = e.side === "host" ? HOST_Y : LAP_Y;
          const to = e.side === "host" ? LAP_Y : HOST_Y;
          const color = e.held ? SOL.red : e.side === "host" ? SOL.cyan : SOL.blue;
          const xa = SX(e.at);
          const xb = SX(e.lands);
          return (
            <g key={i}>
              <circle cx={xa} cy={from} r={4.5} fill={color} className="bj-pop" style={t(e.at * timeScale)} />
              {!e.held && (
                <>
                  <path d={`M${xb} ${from + (to > from ? 6 : -6)}V${to + (to > from ? -8 : 8)}`} pathLength={1} stroke={color} strokeWidth={1.5} fill="none" className="bj-draw" style={t(e.lands * timeScale, 0.25)} />
                  <Head x={xb} y={to + (to > from ? -5 : 5)} dir={to > from ? "d" : "u"} color={color} style={t(e.lands * timeScale + 0.25)} />
                </>
              )}
              {i < 4 && (
                <text x={xa + 7} y={from + (e.side === "host" ? -10 : 18)} fontSize="9.5" fill={e.side === "host" ? SOL.base0 : SOL.base01} className="bj-fade" style={t(e.at * timeScale)}>{e.file}</text>
              )}
            </g>
          );
        })}

        <g className="bj-rise" style={t(21 * timeScale + 0.2)}>
          <rect x={SX(21) + 8} y={104} width={222} height={34} rx={6} fill={SOL.base3} stroke={SOL.red} strokeOpacity={0.6} />
          <text x={SX(21) + 16} y={118} fontSize="9.5" fill={SOL.red}>routes.ts held: changed on both sides</text>
          <text x={SX(21) + 16} y={131} fontSize="9.5" fill={SOL.base01}>v2.ts still landed on the laptop</text>
        </g>

        <text x={SX(24) + 6} y={HOST_Y - 12} fontSize="9.5" fill={SOL.base0} className="bj-fade" style={t(24 * timeScale + 0.3)}>agent goes quiet</text>
        <text x={752} y={LAP_Y + 20} textAnchor="end" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(27 * timeScale)}>paused: laptop read every 15 s</text>
        <text x={SX(0)} y={232} fontSize="9.5" fill={SOL.base1}>
          <tspan fill={SOL.cyan}>●</tspan> host edit <tspan dx={14} fill={SOL.blue}>●</tspan> laptop edit <tspan dx={14} fill={SOL.red}>●</tspan> same file on both sides <tspan dx={14}>┆</tspan> sync tick
        </text>
      </svg>
    </Stage>
  );
}

// ─── Figure 6: a migration batch ───────────────────────────────────────────

const STAGES = ["queued", "waiting for turn", "stopping", "transferring", "handing off", "resuming", "done"];

const ROWS: { id: string; note: string; reach: number; speed: number; fail?: string; held?: number; prompt?: boolean }[] = [
  { id: "jx7k2pd", note: "idle at a prompt", reach: 6, speed: 0.45 },
  { id: "jx79tnw", note: "mid-turn, finishes first", reach: 6, speed: 0.75, held: 2 },
  { id: "jx72ss5", note: "at a permission prompt", reach: 6, speed: 0.4, prompt: true },
  { id: "jx77bkw", note: "host checkout busy", reach: 3, speed: 0.55, fail: "restarted where it was" },
  { id: "jx75me8", note: "queued behind two", reach: 6, speed: 0.6 },
];

export function MigrateFigure() {
  const X0 = 150;
  const W = 82;
  return (
    <Stage minWidth={680}>
      <svg viewBox="0 0 740 300" className="w-full block font-mono" role="img" aria-label="A migration batch moving five sessions">
        {STAGES.map((s, i) => (
          <text key={s} x={X0 + i * W + W / 2} y={30} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>{s}</text>
        ))}
        {ROWS.map((r, ri) => {
          const y = 56 + ri * 46;
          const end = X0 + r.reach * W + W / 2;
          const startAt = ri === 4 ? 1.6 : ri * 0.12;
          const dur = r.reach * r.speed;
          return (
            <g key={r.id}>
              <text x={14} y={y + 4} fontSize="11" fontWeight={700} fill={SOL.base02}>{r.id}</text>
              <text x={14} y={y + 18} fontSize="9" fill={SOL.base1}>{r.note}</text>
              <path d={`M${X0 + W / 2} ${y}H${X0 + 6 * W + W / 2}`} stroke={SOL.base2} strokeWidth={2} />
              {STAGES.map((_, si) => (
                <circle key={si} cx={X0 + si * W + W / 2} cy={y} r={3} fill={SOL.base3} stroke={SOL.base2} strokeWidth={1.5} />
              ))}
              <path d={`M${X0 + W / 2} ${y}H${end}`} pathLength={1} stroke={r.fail ? SOL.red : SOL.orange} strokeWidth={3} strokeLinecap="round" fill="none" className="bj-draw" style={t(startAt, dur)} />
              <circle cx={end} cy={y} r={5.5} fill={r.fail ? SOL.red : r.reach === 6 ? SOL.green : SOL.orange} className="bj-pop" style={t(startAt + dur)} />
              {r.held && (
                <g className="bj-pop" style={t(startAt + 0.3)}>
                  <rect x={X0 + W + 14} y={y - 25} width={110} height={15} rx={7} fill={`${SOL.yellow}26`} />
                  <text x={X0 + W + 69} y={y - 14.5} textAnchor="middle" fontSize="9" fill={SOL.yellow}>{r.held} messages held</text>
                </g>
              )}
              {r.prompt && (
                <text x={X0 + 5 * W + 20} y={y - 10} fontSize="9" fill={SOL.base01} className="bj-fade" style={t(startAt + dur)}>asks again on the host</text>
              )}
              {r.fail && (
                <text x={end + 12} y={y + 4} fontSize="9.5" fill={SOL.red} className="bj-fade" style={t(startAt + dur + 0.1)}>failed · {r.fail}</text>
              )}
            </g>
          );
        })}
        <text x={14} y={290} fontSize="9.5" fill={SOL.base1}>sessions transfer two at a time by default; a turn gets 10 minutes to finish before it is interrupted</text>
      </svg>
    </Stage>
  );
}

// ─── Figure 7: a host's day, asleep and awake ──────────────────────────────

const MX = (m: number) => 70 + m * 12;

export function SleepFigure() {
  const WORK_END = 12;
  const OFF = 33;
  const QUEUE = 41;
  const UP = 42;
  return (
    <Stage minWidth={640}>
      <svg viewBox="0 0 760 240" className="w-full block font-mono" role="img" aria-label="A Linux host going idle, stopping, and waking for queued work">
        {[0, 10, 20, 30, 40, 48].map((m) => (
          <text key={m} x={MX(m)} y={224} textAnchor="middle" fontSize="9.5" fill={SOL.base1}>{m} min</text>
        ))}
        <text x={14} y={58} fontSize="10" fill={SOL.base01}>agent</text>
        <rect x={MX(0)} y={48} width={MX(WORK_END) - MX(0)} height={14} rx={3} fill={SOL.green} className="bj-grow" style={t(0.1, 1)} />
        <text x={MX(WORK_END) + 6} y={59} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.1)}>turn ends; an idle prompt is not work</text>

        <text x={14} y={104} fontSize="10" fill={SOL.base01}>watchdog</text>
        {Array.from({ length: 15 }, (_, i) => 5 + i * 2).filter((m) => m <= OFF).map((m, i) => (
          <path key={m} d={`M${MX(m)} 94v16`} stroke={SOL.base1} strokeWidth={1.5} className="bj-fade" style={t(0.2 + i * 0.12)} />
        ))}
        <text x={MX(5)} y={128} fontSize="9" fill={SOL.base1}>checks 5 min after boot, then every 2</text>

        <text x={14} y={160} fontSize="10" fill={SOL.base01}>idle for</text>
        <rect x={MX(WORK_END)} y={150} width={MX(WORK_END + 20) - MX(WORK_END)} height={14} rx={3} fill={`${SOL.yellow}55`} className="bj-grow" style={t(1.2, 1.6)} />
        <text x={MX(WORK_END) + 8} y={161} fontSize="9.5" fill={SOL.base02} className="bj-fade" style={t(1.6)}>20 idle minutes</text>

        <g className="bj-pop" style={t(2.9)}>
          <rect x={MX(OFF) - 2} y={36} width={MX(QUEUE) - MX(OFF) + 4} height={140} fill={NIGHT} rx={4} />
          <text x={(MX(OFF) + MX(QUEUE)) / 2} y={98} textAnchor="middle" fontSize="10" fill={SOL.base0}>stopped</text>
          <text x={(MX(OFF) + MX(QUEUE)) / 2} y={112} textAnchor="middle" fontSize="9" fill={SOL.base01}>disk only</text>
        </g>
        <text x={MX(OFF)} y={196} textAnchor="middle" fontSize="9.5" fill={SOL.red} className="bj-fade" style={t(2.9)}>poweroff</text>

        <path d={`M${MX(QUEUE)} 36v140`} stroke={SOL.blue} strokeWidth={1.5} className="bj-draw" pathLength={1} style={t(3.5, 0.3)} />
        <text x={MX(QUEUE) + 6} y={196} fontSize="9.5" fill={SOL.blue} className="bj-fade" style={t(3.5)}>a trigger fires for it</text>
        <rect x={MX(QUEUE)} y={48} width={MX(UP) - MX(QUEUE)} height={14} fill={`${SOL.blue}55`} className="bj-grow" style={t(3.8, 0.4)} />
        <rect x={MX(UP)} y={48} width={MX(47) - MX(UP)} height={14} rx={3} fill={SOL.green} className="bj-grow" style={t(4.2, 0.6)} />
        <text x={MX(QUEUE) + 6} y={86} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(4.2)}>
          <tspan x={MX(QUEUE) + 6}>a laptop sees the request,</tspan>
          <tspan x={MX(QUEUE) + 6} dy={13}>starts the instance;</tspan>
          <tspan x={MX(QUEUE) + 6} dy={13} fill={SOL.green}>answered 60 s later</tspan>
        </text>
      </svg>
    </Stage>
  );
}

// ─── Table: the four clouds ────────────────────────────────────────────────

const CLOUDS: { name: string; color: string; cells: ReactNode[] }[] = [
  { name: "Your cloud host", color: SOL.blue, cells: ["Yours, in your AWS account", "Your checkout as it is, or origin/main", "Yes, any agent", "Yes", "Claude Code sessions, both ways"] },
  { name: "Cursor Cloud", color: SOL.violet, cells: ["Cursor's", "The branch as it is on GitHub", "Yes", "Yes", "No"] },
  { name: "Codex Cloud", color: SOL.green, cells: ["OpenAI's", "The repository on GitHub", "Yes, 1 to 4 attempts", "Draft PR, apply locally", "No"] },
  { name: "Claude Code on the web", color: SOL.orange, cells: ["Anthropic's", "A session you started on claude.ai", "No, mirrored only", "Yes", "No"] },
];

const COLS = ["Whose machine", "Starts from", "Launch from codecast", "Follow-ups", "Moves to your laptop"];

export function CloudsTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left font-mono text-[12.5px]">
        <thead>
          <tr style={{ backgroundColor: SOL.base2, color: SOL.base01 }}>
            <th className="px-4 py-2.5 font-semibold" />
            {COLS.map((c) => <th key={c} className="px-3 py-2.5 font-semibold">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {CLOUDS.map((r) => (
            <tr key={r.name} className="border-t" style={{ borderColor: SOL.base2 }}>
              <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: r.color }}>{r.name}</td>
              {r.cells.map((c, i) => <td key={i} className="px-3 py-3 leading-snug" style={{ color: SOL.base01 }}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
