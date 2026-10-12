"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Sheet, type Ink } from "../figureParts";

/**
 * Figures for the team sessions guide. The sharing rule is resolveTeamForPath
 * in convex/privacy.ts, in the words Settings uses for it.
 */

// ─── Who sees a session: the rule, in the order it is applied ──────────────

const CASES: { path: string; rule: string; why: string; team: boolean }[] = [
  { path: "~/src/product/api", rule: "product shared with Acme", why: "the folder it runs in is shared", team: true },
  { path: "~/src/product/scratch", rule: "scratch set to Never share", why: "the closer folder wins", team: false },
  { path: "~/.codex/worktrees/a1f3", rule: "a copy of the product repo", why: "a clone follows its repository", team: true },
  { path: "~/src/product/api", rule: "started before you shared", why: "From today on keeps old work private", team: false },
  { path: "~/personal/experiments", rule: "nothing shared", why: "private is the default", team: false },
];

/** Five sessions on one account, resolved the way the server does when each is created. */
export function VisibilityRuleFigure() {
  const rowY = (i: number) => 46 + i * 46;
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={284} label="Sharing is decided per directory: the longest matching path rule wins, a repository rule covers clones outside it, and everything else stays private">
        {(arrow) => (
          <>
            {[["where the session runs", 16], ["what applies", 250], ["outcome", 610]].map(([h, x]) => (
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
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r pb-4" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Feed" sub="Every session the team can see, newest activity first." color={SOL.blue} />
          <div className="px-4 pt-3 space-y-1.5">
            {feed.map((r, i) => <Card key={r.title} r={r} at={0.2 + i * 0.12} />)}
          </div>
        </div>
        <div className="pb-4">
          <PanelHead title="Inbox" sub="Your sessions, filed by who has to act next." color={SOL.yellow} />
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
