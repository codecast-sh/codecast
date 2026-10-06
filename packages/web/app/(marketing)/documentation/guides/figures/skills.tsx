"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet } from "../figureParts";

/**
 * Figures for the skills guide. The catalog and install rules are
 * packages/cli/src/bundledSkills.ts and installSkillsSnippet in index.ts; the
 * bakeoff steps are packages/cli/skills/cast-bakeoff/SKILL.md.
 */

// ─── What a skill costs before and after it is invoked ─────────────────────

const DESCRIPTIONS = ["cast-pickup", "cast-handoff", "cast-ship", "cast-verify", "cast-why", "cast-bakeoff", "cast-loop", "…17 more"];

const BODY = [
  "## Write it",
  "goal, decisions and why, what is verified,",
  "open questions, next steps in order",
  "## File it",
  "cast doc create … · cast state --status …",
  "## Hand it on",
  "cast handoff --to · fork · spawn · send",
];

/** Every description is listed up front; a body loads only when its skill runs. */
export function SkillLoadingFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Every session" sub="One description line per skill. That is the whole standing cost." color={SOL.base1} />
          <div className="m-4 font-mono text-[11.5px] space-y-1">
            {DESCRIPTIONS.map((d, i) => (
              <div key={d} className="flex items-center gap-2 bj-rise" style={t(0.1 + i * 0.08)}>
                <span className="h-1.5 rounded-full shrink-0" style={{ width: 10, backgroundColor: d === "cast-handoff" ? SOL.violet : SOL.base1 }} />
                <span style={{ color: d === "cast-handoff" ? SOL.violet : SOL.base01, fontWeight: d === "cast-handoff" ? 700 : 400 }}>{d}</span>
                {i < 7 && <span className="h-1 rounded-full flex-1" style={{ backgroundColor: SOL.base2, maxWidth: 90 + ((i * 37) % 60) }} />}
              </div>
            ))}
          </div>
        </div>
        <div>
          <PanelHead title="/cast-handoff" sub="Typed, or matched from the task: the body loads now." color={SOL.violet} />
          <div className="m-4 rounded-lg p-3 font-mono text-[11.5px] bj-rise" style={{ ...t(1.0), backgroundColor: `${SOL.violet}10`, border: `1px solid ${SOL.violet}` }}>
            <div className="text-[10.5px] mb-1.5" style={{ color: SOL.violet }}>~/.claude/skills/cast-handoff/SKILL.md</div>
            {BODY.map((b, i) => (
              <div key={b} className="bj-rise" style={{ ...t(1.3 + i * 0.12), color: b.startsWith("##") ? SOL.violet : SOL.base02, fontWeight: b.startsWith("##") ? 700 : 400 }}>{b}</div>
            ))}
          </div>
          <div className="mx-4 mb-4 text-[11px] font-mono bj-fade" style={{ ...t(2.3), color: SOL.base01 }}>
            Each step is an ordinary cast command. The skill fixes the order and the evidence.
          </div>
        </div>
      </div>
    </Stage>
  );
}

// ─── From the binary to ~/.claude/skills ───────────────────────────────────

const ENTRIES = [
  { y: 30, title: "setup wizard" },
  { y: 86, title: "cast install skills" },
  { y: 142, title: "Settings toggle" },
];

const FILES = [
  { name: "cast-ship/", note: "text changed: rewritten", ink: SOL.orange },
  { name: "cast-why/", note: "same bytes: untouched", ink: SOL.base1 },
  { name: "cast-mod/", note: "new in this release: written", ink: SOL.green },
  { name: "my-deploy/", note: "yours: never touched", ink: SOL.blue },
];

/** Three entry points, one installer, and a byte comparison per file. */
export function SkillInstallFigure() {
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={250} label="The cast binary carries all 24 skill files. The wizard, cast install skills and the Settings toggle reach one installer, which writes each skill whose text differs and leaves the rest, including your own skills, alone">
        {(arrow) => (
          <>
            <Box x={16} y={70} w={130} h={64} title="cast binary" sub="24 SKILL.md inside" ink="base02" bold={1.6} className="bj-pop" style={t(0.1)} />
            {ENTRIES.map((e, i) => (
              <g key={e.title}>
                <Box x={190} y={e.y} w={150} h={38} title={e.title} ink="base1" className="bj-pop" style={t(0.4 + i * 0.12)} />
                <path d={`M343 ${e.y + 19}C370 ${e.y + 19} 370 102 392 102`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(0.8 + i * 0.1, 0.3)} />
              </g>
            ))}
            <path d="M149 102H186" stroke={SOL.base1} strokeWidth={1.2} className="bj-fade" style={t(0.3)} />
            <Box x={396} y={78} w={120} h={48} title="one installer" sub="skills snippet" ink="violet" bold={1.6} className="bj-pop" style={t(1.2)} />
            <path d="M519 102H546" pathLength={1} stroke={SOL.violet} strokeWidth={1.4} fill="none" markerEnd={arrow("violet")} className="bj-draw" style={t(1.5, 0.2)} />

            <text x={552} y={40} fontSize="10.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(1.6)}>~/.claude/skills/</text>
            {FILES.map((f, i) => (
              <g key={f.name} className="bj-rise" style={t(1.8 + i * 0.2)}>
                <text x={562} y={62 + i * 36} fontSize="11" fontWeight={700} fill={SOL.base02}>{f.name}</text>
                <text x={562} y={76 + i * 36} fontSize="10" fill={f.ink}>{f.note}</text>
              </g>
            ))}
            <Label x={16} y={214} lines={["--disable removes the 24 cast-* directories and nothing else.", "After a CLI update, the refresh rewrites only the skills whose text changed."]} ink="base01" size={10.5} className="bj-fade" style={t(2.8)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── /cast-bakeoff, step by step ───────────────────────────────────────────

/** Fork once per approach, wait without polling, then judge on evidence. */
export function BakeoffFigure() {
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={260} label="cast-bakeoff forks the conversation once per approach, each branch in its own worktree. It waits on a session watch that prints only when a branch changes state, then compares each branch's diff and transcript and stashes the losers">
        {(arrow) => (
          <>
            <Box x={16} y={100} w={150} h={56} title="/cast-bakeoff" sub="table | buffer" ink="violet" bold={1.6} className="bj-pop" style={t(0.1)} />
            <Label x={16} y={180} lines={["cast fork --tip", "--label bakeoff-retry"]} ink="base01" size={10} className="bj-fade" style={t(0.4)} />

            {[
              { y: 40, title: "branch A", sub: "queue table · own worktree", win: true },
              { y: 160, title: "branch B", sub: "in memory buffer · own worktree", win: false },
            ].map((b, i) => (
              <g key={b.title}>
                <path d={`M169 128C210 128 210 ${b.y + 28} 246 ${b.y + 28}`} pathLength={1} fill="none" stroke={SOL.violet} strokeWidth={1.4} markerEnd={arrow("violet")} className="bj-draw" style={t(0.6 + i * 0.15, 0.3)} />
                <Box x={250} y={b.y} w={200} h={56} title={b.title} sub={b.sub} ink="blue" className="bj-pop" style={t(0.8 + i * 0.15)} />
                <rect x={262} y={b.y + 47} width={176} height={3} rx={1.5} fill={SOL.blue} className="bj-grow" style={t(1.0 + i * 0.15, 1.4 + i * 0.5)} />
                <path d={`M453 ${b.y + 28}C490 ${b.y + 28} 490 128 526 128`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(2.6 + i * 0.4, 0.3)} />
                <g className="bj-pop" style={t(2.5 + i * 0.4)}>
                  <circle cx={450} cy={b.y + 2} r={7} fill={SOL.blue} />
                </g>
              </g>
            ))}
            <Label x={350} y={128} lines={["cast sessions --label … -w --json", "silent until a branch settles"]} ink="base01" size={10} anchor="middle" className="bj-fade" style={t(1.4)} />

            <Box x={530} y={96} w={210} h={64} title="cast diff + cast read" sub="a table: diff, evidence, cost" ink="base02" className="bj-pop" style={t(3.4)} />
            <g className="bj-rise" style={t(4.0)}>
              <rect x={530} y={176} width={210} height={26} rx={6} fill={`${SOL.green}1f`} stroke={SOL.green} />
              <text x={635} y={193} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.green}>verdict: branch A</text>
            </g>
            <Label x={635} y={222} lines={["branch B is stashed"]} ink="base1" size={10} anchor="middle" className="bj-fade" style={t(4.4)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
