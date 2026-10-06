"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the team sessions guide. Transcript roots are the ones in
 * shared/contracts/agentClients.ts; the sharing rule is resolveTeamForPath in
 * convex/privacy.ts.
 */

// ─── The daemon: files the agents already write, synced as they grow ───────

const ROOTS: { agent: string; path: string; ink: Ink }[] = [
  { agent: "Claude Code", path: "~/.claude/projects/*.jsonl", ink: "orange" },
  { agent: "Codex", path: "~/.codex/sessions/*.jsonl", ink: "violet" },
  { agent: "Cursor", path: "~/.cursor/chats (sqlite)", ink: "base02" },
  { agent: "OpenCode", path: "~/.local/share/opencode/opencode.db", ink: "cyan" },
  { agent: "pi, Grok, Gemini", path: "~/.pi, ~/.grok, ~/.gemini", ink: "blue" },
];

/** Agents write their own history; the daemon reads it and syncs each line as it lands. */
export function DaemonSyncFigure() {
  const rowY = (i: number) => 34 + i * 44;
  const D = { x: 322, y: 108, w: 124, h: 66 };
  const WS = { x: D.x + D.w + 52, w: 104 };
  const OX = WS.x + WS.w + 30;
  const OUT = [
    { y: 70, title: "feed", sub: "newest first" },
    { y: 172, title: "inbox", sub: "by who acts next" },
  ];
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={262} label="Each agent writes its transcript to disk; the codecast daemon watches those files and syncs every conversation to the team's workspace">
        {(arrow) => (
          <>
            <text x={16} y={16} fontSize="10" fill={SOL.base1}>on each teammate's machine</text>
            {ROOTS.map((r, i) => {
              const y = rowY(i);
              const at = 0.15 + i * 0.12;
              return (
                <g key={r.agent}>
                  <g className="bj-rise" style={t(at)}>
                    <rect x={16} y={y} width={244} height={34} rx={6} fill={SOL.base3} stroke={SOL.base2} />
                    <rect x={16} y={y} width={3} height={34} rx={1.5} fill={SOL[r.ink]} />
                    <text x={28} y={y + 14} fontSize="11" fontWeight={700} fill={SOL.base02}>{r.agent}</text>
                    <text x={28} y={y + 27} fontSize="9.5" fill={SOL.base01}>{r.path}</text>
                  </g>
                  {/* new lines landing in the file */}
                  {[0, 1, 2].map((k) => (
                    <rect key={k} x={232 + k * 7} y={y + 9} width={4} height={16} rx={1} fill={SOL[r.ink]} opacity={0.5} className="bj-pop" style={t(1.0 + i * 0.2 + k * 0.35)} />
                  ))}
                  <path d={`M262 ${y + 17}C300 ${y + 17} 300 ${D.y + D.h / 2} ${D.x - 6} ${D.y + D.h / 2}`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.2} strokeDasharray="3 3" className="bj-fade" style={t(0.8 + i * 0.1)} />
                </g>
              );
            })}
            {/* a message travelling the whole way, live */}
            <circle r={4} fill={SOL.orange} className="bj-fade" style={t(2.6)}>
              <animateMotion dur="2.4s" repeatCount="indefinite" begin="2.6s" path={`M262 51C300 51 300 141 ${D.x - 6} 141H${WS.x - 8}`} />
            </circle>
            <Box x={D.x} y={D.y} w={D.w} h={D.h} title="cast daemon" sub="watches the files" ink="base02" bold={1.5} className="bj-pop" style={t(0.7)} />
            <Label x={D.x + D.w / 2} y={D.y + D.h + 20} anchor="middle" lines={["no change to how", "anyone runs an agent"]} size={9.5} ink="base1" className="bj-fade" style={t(1.2)} />

            <path d={`M${D.x + D.w + 4} ${D.y + D.h / 2}H${WS.x - 6}`} pathLength={1} stroke={SOL.base02} strokeWidth={1.5} markerEnd={arrow("base02")} className="bj-draw" style={t(1.3, 0.4)} />
            <Box x={WS.x} y={D.y + 4} w={WS.w} h={58} title="workspace" sub="team or private" ink="cyan" fill={`${SOL.cyan}12`} className="bj-pop" style={t(1.7)} />
            {OUT.map((o, i) => (
              <g key={o.title}>
                <path d={`M${WS.x + WS.w + 4} ${D.y + D.h / 2}C${OX - 16} ${D.y + D.h / 2} ${OX - 24} ${o.y + 22} ${OX - 6} ${o.y + 22}`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.3} markerEnd={arrow("base1")} className="bj-draw" style={t(2.0 + i * 0.2, 0.35)} />
                <Box x={OX} y={o.y} w={112} h={44} title={o.title} sub={o.sub} ink="base1" className="bj-pop" style={t(2.3 + i * 0.2)} />
              </g>
            ))}
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Who sees a session: the rule, in the order it is applied ──────────────

const CASES: { path: string; rule: string; why: string; team: boolean }[] = [
  { path: "~/src/product/api", rule: "~/src/product → Acme, share", why: "longest path prefix", team: true },
  { path: "~/src/product/scratch", rule: "~/src/product/scratch → never share", why: "a lock beats the shorter rule", team: false },
  { path: "~/.codex/worktrees/a1f3", rule: "repo github.com/acme/product", why: "no path rule: the clone's repository", team: true },
  { path: "~/src/product/api", rule: "started before the share date", why: "share_since keeps old work private", team: false },
  { path: "~/personal/experiments", rule: "no rule", why: "private is the default", team: false },
];

/** Five sessions on one account, resolved the way the server does when each is created. */
export function VisibilityRuleFigure() {
  const rowY = (i: number) => 46 + i * 46;
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={284} label="Sharing is decided per directory: the longest matching path rule wins, a repository rule covers clones outside it, and everything else stays private">
        {(arrow) => (
          <>
            {[["session's directory", 16], ["matching rule", 250], ["outcome", 610]].map(([h, x]) => (
              <text key={h as string} x={x as number} y={24} fontSize="10" fill={SOL.base1}>{h as string}</text>
            ))}
            {CASES.map((c, i) => {
              const y = rowY(i);
              const at = 0.2 + i * 0.45;
              const ink: Ink = c.team ? "cyan" : "base01";
              return (
                <g key={i}>
                  <g className="bj-rise" style={t(at)}>
                    <rect x={16} y={y} width={200} height={30} rx={6} fill={SOL.base3} stroke={SOL.base2} />
                    <text x={26} y={y + 19} fontSize="11" fill={SOL.base02}>{c.path}</text>
                  </g>
                  <path d={`M220 ${y + 15}H242`} pathLength={1} stroke={SOL.base1} markerEnd={arrow("base1")} className="bj-draw" style={t(at + 0.15, 0.2)} />
                  <g className="bj-rise" style={t(at + 0.2)}>
                    <text x={250} y={y + 12} fontSize="10.5" fontWeight={700} fill={SOL.base02}>{c.rule}</text>
                    <text x={250} y={y + 26} fontSize="9.5" fill={SOL.base01}>{c.why}</text>
                  </g>
                  <path d={`M560 ${y + 15}H602`} pathLength={1} stroke={SOL[ink]} markerEnd={arrow(ink)} className="bj-draw" style={t(at + 0.3, 0.2)} />
                  <g className="bj-pop" style={t(at + 0.4)}>
                    <rect x={610} y={y + 2} width={128} height={26} rx={13} fill={c.team ? `${SOL.cyan}1c` : SOL.base2} stroke={c.team ? SOL.cyan : "none"} />
                    <text x={674} y={y + 19} textAnchor="middle" fontSize="10.5" fontWeight={700} fill={c.team ? SOL.cyan : SOL.base01}>{c.team ? "team-visible" : "private"}</text>
                  </g>
                </g>
              );
            })}
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Feed and inbox: the same sessions, two questions ──────────────────────

type Row = { title: string; who: string; agent: string; ago: number; state: "needs" | "working" | "done" };
const SESSIONS: Row[] = [
  { title: "Retry failed webhooks", who: "Alex", agent: "Claude Code", ago: 1, state: "working" },
  { title: "Fix flaky checkout e2e", who: "Maya", agent: "Cursor", ago: 6, state: "needs" },
  { title: "Upgrade Stripe SDK to v14", who: "Sarah", agent: "Claude Code", ago: 25, state: "done" },
  { title: "Migrate invoices to Postgres 16", who: "Maya", agent: "Codex", ago: 2, state: "working" },
  { title: "Audit log export to S3", who: "Alex", agent: "Codex", ago: 47, state: "done" },
];
const STATE: Record<Row["state"], { label: string; ink: string }> = {
  needs: { label: "Needs input", ink: SOL.yellow },
  working: { label: "Working", ink: SOL.green },
  done: { label: "Done", ink: SOL.cyan },
};

function Card({ r, at, chip }: { r: Row; at: number; chip?: boolean }) {
  return (
    <div className="rounded-md px-3 py-1.5 font-mono bj-rise flex items-baseline gap-2" style={{ ...t(at), backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 self-center" style={{ backgroundColor: STATE[r.state].ink }} />
      <span className="text-[12px] truncate" style={{ color: SOL.base02 }}>{r.title}</span>
      <span className="ml-auto text-[10.5px] shrink-0" style={{ color: SOL.base1 }}>{chip ? r.who : `${r.who} · ${r.ago}m`}</span>
    </div>
  );
}

/** The feed answers "what is happening"; the inbox answers "what needs me". */
export function FeedInboxFigure() {
  const feed = [...SESSIONS].sort((a, b) => a.ago - b.ago);
  const groups: Row["state"][] = ["needs", "done", "working"];
  let n = 0;
  return (
    <Stage>
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r pb-4" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="/feed" sub="Every session the team can see, newest activity first." color={SOL.blue} />
          <div className="px-4 pt-3 space-y-1.5">
            {feed.map((r, i) => <Card key={r.title} r={r} at={0.2 + i * 0.12} />)}
          </div>
        </div>
        <div className="pb-4">
          <PanelHead title="/inbox" sub="The same sessions, filed by who has to act next." color={SOL.yellow} />
          <div className="px-4 pt-3 space-y-2">
            {groups.map((g) => (
              <div key={g}>
                <div className="font-mono text-[10px] uppercase tracking-wider mb-1 bj-fade" style={{ ...t(1.0 + n * 0.1), color: STATE[g].ink }}>{STATE[g].label}</div>
                <div className="space-y-1.5">
                  {SESSIONS.filter((r) => r.state === g).map((r) => <Card key={r.title} r={r} at={1.1 + n++ * 0.15} chip />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Stage>
  );
}
