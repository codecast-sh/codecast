"use client";

import { SOL } from "../../blog/blogChrome";
import { BLUE, C, Caption, Note, P$, Term } from "./kit";

/** The five things preparing a cloud session does, in order. */
const STEPS: { title: string; body: React.ReactNode }[] = [
  { title: "Wake", body: <>The host boots if it is stopped. Preparation waits up to 3 minutes for Linux, 25 for a Mac.</> },
  { title: "Fetch", body: <>The repo is cloned on the host where it sits on your laptop (<C>~/src/shop</C> there too) if missing, fetched if present. A fetch only: the host checkout keeps its own HEAD and work.</> },
  { title: "Copy secrets", body: <>Files under <C>setup.copy</C> in <C>.codecast/workspace.toml</C> go by rsync, one snapshot per worktree.</> },
  { title: "Worktree", body: <>The host makes its own worktree per task. Dependencies install there and ports are probed on the machine that binds them.</> },
  { title: "Start", body: <>The session row is created pointing at that worktree and routed to the host. Prep runs over SSH from your laptop, which needs to be online; none of it passes through codecast&apos;s servers.</> },
];

/** Laptop HEAD + working changes → hidden ref → host branch, changes uncommitted again. */
function SnapshotDiagram() {
  const node = (x: number, y: number, fill: string, stroke: string) => <circle cx={x} cy={y} r={7} fill={fill} stroke={stroke} strokeWidth={2} />;
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "#e3dcc6" }}>
      <div className="grid md:grid-cols-2">
        <div className="cl-paper p-5 sm:p-6">
          <div className="font-mono text-[12px] mb-4" style={{ color: SOL.base01 }}>your laptop · ~/src/shop</div>
          <svg viewBox="0 0 300 150" className="w-full h-auto" role="img" aria-label="Laptop branch with an unpushed commit and uncommitted changes, snapshotted to a hidden ref">
            <line x1="20" y1="40" x2="190" y2="40" stroke={SOL.base1} strokeWidth="2" />
            {node(30, 40, SOL.base3, SOL.base1)}
            {node(90, 40, SOL.base3, SOL.base1)}
            {node(150, 40, SOL.base3, BLUE)}
            <text x="150" y="20" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="10.5" fill={BLUE}>a41c9e2</text>
            <text x="143" y="64" textAnchor="end" fontFamily="ui-monospace,monospace" fontSize="9.5" fill={SOL.base1}>not pushed</text>
            <line x1="155" y1="46" x2="222" y2="98" stroke={BLUE} strokeWidth="2" strokeDasharray="4 4" />
            <rect x="192" y="98" width="104" height="24" rx="5" fill="rgba(38,139,210,.1)" stroke={BLUE} />
            <text x="245" y="114" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="10" fill={SOL.base02}>snapshot commit</text>
            <text x="40" y="104" fontFamily="ui-monospace,monospace" fontSize="10" fill={SOL.yellow}> M src/routes/v1.ts</text>
            <text x="40" y="122" fontFamily="ui-monospace,monospace" fontSize="10" fill={SOL.base1}>   .env.local</text>
            <text x="40" y="140" fontFamily="ui-monospace,monospace" fontSize="9.5" fill={SOL.base1}>temporary index</text>
          </svg>
          <Note className="mt-3">Your index and branches do not change. The snapshot goes to <C>refs/codecast/cloud/&lt;worktree&gt;</C>, a ref <C>git ls-remote --heads</C> does not list.</Note>
        </div>
        <div className="cl-night p-5 sm:p-6">
          <div className="font-mono text-[12px] mb-4" style={{ color: SOL.base1 }}>the host · ~/src/shop</div>
          <svg viewBox="0 0 300 150" className="w-full h-auto" role="img" aria-label="Host branch reset to the laptop HEAD with changes uncommitted">
            <line x1="20" y1="40" x2="190" y2="40" stroke="#2f5b66" strokeWidth="2" />
            {node(30, 40, SOL.base03, "#4c7680")}
            {node(90, 40, SOL.base03, "#4c7680")}
            {node(150, 40, SOL.base03, SOL.cyan)}
            <text x="150" y="20" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="10.5" fill={SOL.cyan}>a41c9e2</text>
            <text x="150" y="64" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="9.5" fill={SOL.base01}>feature/checkout</text>
            <text x="40" y="104" fontFamily="ui-monospace,monospace" fontSize="10" fill={SOL.yellow}> M src/routes/v1.ts</text>
            <text x="40" y="122" fontFamily="ui-monospace,monospace" fontSize="10" fill={SOL.base0}>   .env.local</text>
            <text x="40" y="140" fontFamily="ui-monospace,monospace" fontSize="9.5" fill={SOL.base01}>uncommitted again</text>
          </svg>
          <Note dark className="mt-3">The host makes a branch under your branch&apos;s name (or <C dark>&lt;branch&gt;-&lt;hex&gt;</C> if it is taken) and resets it to your HEAD, so the agent sees what you saw.</Note>
        </div>
      </div>
    </div>
  );
}

export function SpawnSection() {
  return (
    <>
      <SnapshotDiagram />
      <Caption>If the snapshot, push or reset fails, the spawn fails with git&apos;s error. It never falls back to origin/main quietly.</Caption>

      <ol className="mt-14 rounded-xl border overflow-hidden" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
        {STEPS.map((s, i) => (
          <li key={s.title} className="cl-row grid sm:grid-cols-[190px_1fr] gap-x-6 gap-y-1 px-5 sm:px-6 py-4 border-b last:border-b-0" style={{ borderColor: "#eee5cc" }}>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[12px] tabular-nums" style={{ color: BLUE }}>{i + 1}</span>
              <span className="font-mono font-semibold text-[15px]" style={{ color: SOL.base03 }}>{s.title}</span>
            </div>
            <p className="text-[14.5px] leading-6" style={{ color: SOL.base01 }}>{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-14 grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-x-10 gap-y-8 items-start">
        <div className="space-y-5">
          <Note>
            <b style={{ color: SOL.base02 }}>In the app,</b> switch on <b style={{ color: SOL.base02 }}>run in the cloud</b> in a new session, beside the folder you picked. <b style={{ color: SOL.base02 }}>start from</b> chooses <b style={{ color: SOL.base02 }}>my checkout</b> (your branch and uncommitted work, as above) or <b style={{ color: SOL.base02 }}>origin/main</b> for a clean start. The session&apos;s header shows the host it runs on, and &ldquo;preparing cloud host&rdquo; until it is ready.
          </Note>
          <Note>
            <b style={{ color: SOL.base02 }}>One worktree per session.</b> Parallel agents on the host never share a working tree. Switch off <b style={{ color: SOL.base02 }}>isolated worktree</b> to run in the host&apos;s main checkout instead: that always starts from origin/main on a new <C>codecast/cloud-&lt;hex&gt;</C> branch, and is refused when the checkout is dirty (the files are listed) or another live session holds it (that session is named).
          </Note>
          <Note>
            A laptop daemon that is online runs the preparation, wherever you started the session from. With none online, the session waits for one.
          </Note>
        </div>
        <div>
          <Term machine="laptop" label="for scripts and agents">
            <P$>cast spawn --cloud &quot;port the v1 routes&quot; &quot;write the migration&quot;</P$>
            <P$>cast spawn --cloud --from origin-main &quot;audit the build&quot;</P$>
            <P$>cast spawn --cloud --shared &quot;run the migration&quot;</P$>
            <P$>cast fork --cloud &quot;try the queue approach&quot; &quot;try the cron approach&quot;</P$>
          </Term>
          <Caption>Agents start cloud work the same way. <C>cast fork --cloud</C> branches a conversation onto the host: each branch gets its own host worktree while your direction stays here.</Caption>
        </div>
      </div>
    </>
  );
}
