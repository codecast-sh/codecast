"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Arrow, Box, Sheet } from "../figureParts";

/**
 * Figures for the agent snippets guide: where `cast install` writes, how a
 * section is found and replaced, and how a toggle on the web reaches a file.
 */

// ─── Where a snippet lands ─────────────────────────────────────────────────

const SLUGS = ["memory", "messaging", "forks", "tasks", "triggers", "workflows", "visual", "publish", "state", "browser"];

const TARGETS = [
  { file: "~/.claude/CLAUDE.md", when: "always", ok: true },
  { file: "~/.codex/AGENTS.md", when: "when ~/.codex exists", ok: true },
  { file: "~/.grok/AGENTS.md", when: "when ~/.grok exists", ok: true },
  { file: "Cursor, Gemini, pi", when: "no user-level file they load", ok: false },
];

/** The catalog ships inside the CLI; install writes each section into every
 *  user-level instruction file an agent on this machine reads. */
export function SnippetTargetsFigure() {
  const W = 760;
  const H = 280;
  return (
    <Stage minWidth={660}>
      <Sheet w={W} h={H} label="cast install writes the catalog's sections into CLAUDE.md always, and into Codex and Grok AGENTS.md files when those agents are installed">
        {(arrow) => (
          <>

            <g className="bj-pop" style={t(0.1)}>
              <rect x={20} y={36} width={196} height={206} rx={8} fill={SOL.base3} stroke={SOL.base1} />
              <text x={36} y={60} fontSize="12" fontWeight={700} fill={SOL.base02}>the catalog</text>
              <text x={36} y={76} fontSize="10" fill={SOL.base01}>compiled into the CLI</text>
            </g>
            {SLUGS.map((s, i) => (
              <g key={s} className="bj-rise" style={t(0.3 + i * 0.06)}>
                <rect x={36 + (i % 2) * 86} y={90 + Math.floor(i / 2) * 26} width={80} height={19} rx={4} fill={`${SOL.violet}14`} stroke={`${SOL.violet}55`} />
                <text x={76 + (i % 2) * 86} y={103.5 + Math.floor(i / 2) * 26} textAnchor="middle" fontSize="10" fill={SOL.violet}>{s}</text>
              </g>
            ))}
            <text x={118} y={230} textAnchor="middle" fontSize="10" fill={SOL.base1} className="bj-fade" style={t(1)}>…21 in all</text>

            <Arrow head={arrow()} d="M220 139H270" at={1.0} dur={0.3} />
            <g className="bj-pop" style={t(1.3)}>
              <rect x={276} y={112} width={132} height={54} rx={8} fill={SOL.base03} />
              <text x={342} y={136} textAnchor="middle" fontSize="12.5" fontWeight={700} fill={SOL.base3}>cast install</text>
              <text x={342} y={153} textAnchor="middle" fontSize="10" fill={SOL.base1}>asks per snippet</text>
            </g>

            {TARGETS.map((tg, i) => {
              const y = 46 + i * 56;
              const at = 1.7 + i * 0.3;
              const color = tg.ok ? (i === 0 ? SOL.green : SOL.cyan) : SOL.base1;
              return (
                <g key={tg.file}>
                  <Arrow head={tg.ok ? arrow() : undefined} d={`M410 139C470 139 470 ${y + 18} 522 ${y + 18}`} at={at} color={color} dashed={!tg.ok} dur={0.4} />
                  <g className="bj-rise" style={t(at + 0.35)}>
                    <rect x={528} y={y} width={214} height={38} rx={6} fill={tg.ok ? SOL.base3 : "none"} stroke={color} strokeDasharray={tg.ok ? undefined : "3 3"} />
                    <text x={540} y={y + 16} fontSize="11.5" fontWeight={700} fill={tg.ok ? SOL.base02 : SOL.base1} textDecoration={tg.ok ? undefined : "line-through"}>{tg.file}</text>
                    <text x={540} y={y + 30} fontSize="10" fill={tg.ok ? color : SOL.base1}>{tg.when}</text>
                  </g>
                </g>
              );
            })}
            <text x={342} y={200} textAnchor="middle" fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.0)}>
              <tspan x={342}>user-level files only:</tspan>
              <tspan x={342} dy={13}>a repo's own CLAUDE.md</tspan>
              <tspan x={342} dy={13}>is never touched</tspan>
            </text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Markers: append, leave alone, replace in place ────────────────────────

type Line = { text: string; kind: "yours" | "head" | "body" | "end" | "new" };

const FILE: Line[] = [
  { text: "# How I like to work", kind: "yours" },
  { text: "Run bun test before a commit.", kind: "yours" },
  { text: "## Messaging", kind: "head" },
  { text: "`cast send <session> \"…\"` when…", kind: "body" },
  { text: "<!-- /codecast-messaging -->", kind: "end" },
  { text: "## My deploy checklist", kind: "yours" },
];

const INK: Record<Line["kind"], string> = { yours: SOL.base02, head: SOL.cyan, body: SOL.base01, end: SOL.base1, new: SOL.green };

function FileLine({ line, at, struck, mark }: { line: Line; at: number; struck?: number; mark?: string }) {
  return (
    <div className="relative bj-rise flex items-center gap-2" style={t(at)}>
      <span className="w-1 self-stretch rounded-sm shrink-0" style={{ backgroundColor: line.kind === "yours" ? SOL.base2 : line.kind === "new" ? SOL.green : SOL.cyan, opacity: line.kind === "yours" ? 1 : 0.7 }} />
      <span className="truncate" style={{ color: INK[line.kind] }}>{line.text}</span>
      {mark && <span className="ml-auto shrink-0 text-[10px]" style={{ color: line.kind === "new" ? SOL.green : SOL.base1 }}>{mark}</span>}
      {struck !== undefined && (
        <span className="absolute left-3 right-0 top-1/2 h-px bj-grow" style={{ ...t(struck, 0.35), backgroundColor: SOL.red }} />
      )}
    </div>
  );
}

const CASES = [
  {
    title: "Not there yet",
    sub: "cast install appends it at the end.",
    color: SOL.green,
    lines: [FILE[0], FILE[1], FILE[5], { ...FILE[2], kind: "new" as const }, { ...FILE[3], kind: "new" as const }, { ...FILE[4], kind: "new" as const }],
    fresh: [3, 4, 5],
  },
  {
    title: "Already there",
    sub: "Installing again changes nothing.",
    color: SOL.blue,
    lines: FILE,
    fresh: [] as number[],
  },
  {
    title: "Out of date",
    sub: "An update replaces it where it stands.",
    color: SOL.orange,
    lines: FILE,
    fresh: [] as number[],
    replace: 3,
  },
];

/** The same instruction file under the three cases the installer handles.
 *  Lines outside the heading and the end marker are never touched. */
export function SectionMarkersFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-3">
        {CASES.map((c, ci) => {
          const base = 0.2 + ci * 0.5;
          return (
            <div key={c.title} className={ci < 2 ? "border-b md:border-b-0 md:border-r" : ""} style={{ borderColor: SOL.base2 }}>
              <PanelHead title={c.title} sub={c.sub} color={c.color} />
              <div className="m-4 rounded-lg p-3 font-mono text-[11.5px] leading-[1.9]" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
                <div className="text-[10px] mb-1" style={{ color: SOL.base1 }}>~/.claude/CLAUDE.md</div>
                {c.lines.map((line, i) => {
                  const isFresh = c.fresh.includes(i);
                  if ("replace" in c && i === c.replace) {
                    return (
                      <div key={i}>
                        <FileLine line={line} at={base + i * 0.08} struck={base + 1.1} />
                        <FileLine line={{ text: "`cast send <session> \"…\"` v2", kind: "new" }} at={base + 1.5} />
                      </div>
                    );
                  }
                  return <FileLine key={i} line={line} at={isFresh ? base + 0.9 + (i - 3) * 0.15 : base + i * 0.08} mark={isFresh && i === 3 ? "appended" : undefined} />;
                })}
                {ci === 1 && (
                  <div className="mt-1 text-[10px] bj-fade" style={{ ...t(base + 1.1), color: SOL.blue }}>no write: the file is byte for byte the same</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-5 pb-4 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px]" style={{ color: SOL.base01 }}>
        <span className="flex items-center gap-1.5"><span className="inline-block w-1 h-3 rounded-sm" style={{ backgroundColor: SOL.base2 }} />your lines</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-1 h-3 rounded-sm" style={{ backgroundColor: SOL.cyan, opacity: 0.7 }} />codecast's section, from its heading to its end marker</span>
      </div>
    </Stage>
  );
}

// ─── Two ways a section changes on its own ─────────────────────────────────

/** A web toggle reaches one machine's daemon, which runs the same install
 *  command; a CLI update rewrites only the sections whose content changed. */
export function SnippetRefreshFigure() {
  const W = 760;
  const H = 300;
  return (
    <Stage minWidth={680}>
      <Sheet w={W} h={H} label="A settings toggle reaches the daemon, which runs cast install and reports back on its heartbeat; a CLI update rewrites only sections whose content hash changed">
        {(arrow) => (
          <>

            <text x={20} y={24} fontSize="11.5" fontWeight={700} fill={SOL.base02}>A switch on the Agent features page</text>
            <Box x={20} y={40} w={150} title="Agent features" sub="messaging  ●  on" at={0.2} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M174 65H224" at={0.5} />
            <Box x={230} y={40} w={150} title="this device's" sub="daemon" at={0.75} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M384 65H434" at={1.0} />
            <Box x={440} y={40} w={150} title="cast install" sub="messaging" at={1.25} dark bold={1} size={11.5} />
            <Arrow head={arrow()} d="M594 65H644" at={1.5} />
            <Box x={650} y={40} w={92} title="CLAUDE.md" sub="AGENTS.md" at={1.75} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M305 92C305 128 95 128 95 96" at={2.1} color={SOL.cyan} dashed />
            <text x={200} y={136} textAnchor="middle" fontSize="10" fill={SOL.cyan} className="bj-fade" style={t(2.5)}>every heartbeat reports which snippets are on</text>

            <line x1={20} x2={740} y1={160} y2={160} stroke={SOL.base2} />

            <text x={20} y={186} fontSize="11.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(2.8)}>After a CLI update</text>
            <Box x={20} y={202} w={150} title="cast update" sub="or daemon boot" at={3.0} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M174 227H224" at={3.3} />
            <Box x={230} y={202} w={180} title="for each enabled" sub="hash its new text" at={3.55} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M414 227C440 227 440 214 470 214" at={3.9} color={SOL.orange} />
            <Arrow head={arrow()} d="M414 227C440 227 440 252 470 252" at={3.9} color={SOL.base1} />
            <g className="bj-rise" style={t(4.25)}>
              <text x={478} y={210} fontSize="11" fontWeight={700} fill={SOL.orange}>changed</text>
              <text x={548} y={210} fontSize="10.5" fill={SOL.base01}>rewrite the section in place</text>
              <text x={478} y={256} fontSize="11" fontWeight={700} fill={SOL.base1}>same</text>
              <text x={548} y={256} fontSize="10.5" fill={SOL.base01}>leave the file alone</text>
            </g>
            <text x={20} y={286} fontSize="10" fill={SOL.base1} className="bj-fade" style={t(4.6)}>
              the stored hash, not the version number, decides: a wording change ships with no version bump
            </text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}
