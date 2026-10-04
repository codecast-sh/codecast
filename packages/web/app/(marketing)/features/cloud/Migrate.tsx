"use client";

import { SOL } from "../../blog/blogChrome";
import { BLUE, C, Caption, HOST, LAPTOP, Note, Out, P$, Term, delay } from "./kit";

const STAGES: { name: string; what: string }[] = [
  { name: "Fence", what: "No daemon delivers into it. Messages sent now wait, and ride the resume." },
  { name: "Wait", what: "A mid-turn session finishes its turn, up to --wait minutes (10 by default)." },
  { name: "Quiesce", what: "The owner stops the agent so the transcript on disk is final." },
  { name: "Transfer", what: "Worktree by git over SSH, gitignored files, the transcript with paths rewritten." },
  { name: "Flip", what: "Owner and path move in one write; the destination resumes, the old owner lets go." },
];

/** Each row sits at a stage index; -1 is queued (not fenced until its turn), 5 is done. */
const ROWS: { id: string; title: string; at: number; note: string; tone: string }[] = [
  { id: "jx7k2pd", title: "port the v1 routes", at: 5, note: "resumed on the host", tone: SOL.green },
  { id: "jx7m4qe", title: "write the migration", at: 3, note: "shares a worktree: pushed once", tone: BLUE },
  { id: "jx7c1tw", title: "fix the flaky auth test", at: 2, note: "stopped at a permission prompt: moves now, re-asks there", tone: SOL.violet },
  { id: "jx7p9ra", title: "nightly backfill", at: 1, note: "mid turn: finishing first, 2 messages waiting", tone: SOL.yellow },
  { id: "jx7v8hn", title: "triage the inbox", at: -1, note: "queued: not fenced until its turn", tone: SOL.base1 },
];

function StageTrack() {
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[200px_repeat(5,1fr)] border-b" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base2 }}>
            <div className="px-4 py-3 font-mono text-[11.5px]" style={{ color: SOL.base01 }}>batch mg-4k7q2z9a · {LAPTOP} → {HOST}</div>
            {STAGES.map((s, i) => (
              <div key={s.name} className="px-3 py-3 font-mono text-[12.5px] font-semibold border-l" style={{ color: SOL.base02, borderColor: "#e3dcc6" }}>
                <span className="tabular-nums mr-1.5 font-normal" style={{ color: BLUE }}>{i + 1}</span>{s.name}
              </div>
            ))}
          </div>
          {ROWS.map((r, ri) => (
            <div key={r.id} className="cl-row grid grid-cols-[200px_repeat(5,1fr)] items-center border-b last:border-b-0" style={{ borderColor: "#eee5cc" }}>
              <div className="px-4 py-3 min-w-0">
                <div className="font-mono text-[12px]" style={{ color: SOL.base1 }}>{r.id}</div>
                <div className="text-[13.5px] truncate" style={{ color: SOL.base02 }}>{r.title}</div>
              </div>
              <div className="col-span-5 relative h-full py-3 px-3">
                <div className="relative h-8">
                  <div className="absolute left-0 right-0 top-1/2 h-px" style={{ backgroundColor: "#e3dcc6" }} />
                  {r.at >= 0 ? (
                    <div
                      className="absolute left-0 top-1/2 h-[3px] -mt-[1px] rounded-full cl-anim cl-fade"
                      style={delay(0.2 + ri * 0.12, { width: `${Math.min(r.at, 4) * 20 + 10}%`, backgroundColor: r.tone })}
                    />
                  ) : null}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 flex items-center gap-2 cl-anim cl-rise"
                    style={delay(0.3 + ri * 0.12, { left: r.at < 0 ? "0%" : `${Math.min(r.at, 4) * 20 + 10}%`, transform: "translate(-6px,-50%)" })}
                  >
                    <span
                      className={`w-3 h-3 rounded-full border-2 shrink-0 ${r.at > 0 && r.at < 5 ? "cl-breathe" : ""}`}
                      style={{ borderColor: r.tone, backgroundColor: r.at === 5 ? r.tone : SOL.base3 }}
                    />
                    <span className="font-mono text-[11.5px] whitespace-nowrap px-1.5 rounded" style={{ color: r.tone === SOL.base1 ? SOL.base01 : r.tone, backgroundColor: "rgba(253,246,227,.92)" }}>{r.note}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The divider every ownership flip writes into the transcript. */
function Divider() {
  return (
    <div className="rounded-xl border px-5 py-5" style={{ borderColor: "#e3dcc6", backgroundColor: "#fffbf0" }}>
      <div className="text-[13.5px] leading-6" style={{ color: SOL.base01 }}>
        <span className="font-mono text-[11.5px] mr-2" style={{ color: SOL.base1 }}>you</span>also add the v2 rate limits
      </div>
      <div className="flex items-center gap-3 my-4">
        <span className="flex-1 h-px" style={{ backgroundColor: BLUE, opacity: 0.4 }} />
        <span className="font-mono text-[11.5px] text-center" style={{ color: BLUE }}>[codecast] Now running on {HOST} (was {LAPTOP}).</span>
        <span className="flex-1 h-px" style={{ backgroundColor: BLUE, opacity: 0.4 }} />
      </div>
      <div className="text-[13.5px] leading-6" style={{ color: SOL.base02 }}>
        <span className="font-mono text-[11.5px] mr-2" style={{ color: SOL.base1 }}>claude</span>Picking up the rate limits in src/routes/v2/limits.ts.
      </div>
    </div>
  );
}

export function MigrateSection() {
  return (
    <>
      <StageTrack />
      <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {STAGES.map((s, i) => (
          <div key={s.name}>
            <div className="font-mono text-[12.5px] font-semibold" style={{ color: SOL.base02 }}><span style={{ color: BLUE }}>{i + 1}</span> {s.name}</div>
            <p className="mt-1 text-[13.5px] leading-6" style={{ color: SOL.base01 }}>{s.what}</p>
          </div>
        ))}
      </div>

      <div className="mt-16 grid lg:grid-cols-[1.25fr_1fr] gap-8 items-start">
        <div>
          <Term machine="laptop" label="plan first, then move">
            <P$>cast migrate start --to {HOST.slice(0, 6)} --label rollout --dry-run</P$>
            <Out>{"  would move  "}<span style={{ color: SOL.base02 }}>jx7k2pd   port the v1 routes</span>{"  (" + LAPTOP + " → " + HOST + ")"}</Out>
            <Out>{"  would move  "}<span style={{ color: SOL.base02 }}>jx7m4qe   write the migration</span>{"  (" + LAPTOP + " → " + HOST + ")"}</Out>
            <Out>{"  would move  "}<span style={{ color: SOL.base02 }}>jx7p9ra   nightly backfill</span>{"  (" + LAPTOP + " → " + HOST + ")"}</Out>
            <Out tone={SOL.base1}>{"  skip       jx7q0aa   review the diff: only Claude Code sessions can be transferred"}</Out>
            <Out tone={SOL.base1}>{"  skip       jx7r5bb   lint pass: a subagent moves with its parent"}</Out>
            <Out tone={SOL.base01}>{"dry run: 3 would move to " + HOST + ", 2 skipped"}</Out>
            <Out>{" "}</Out>
            <P$>cast migrate start --to {HOST.slice(0, 6)} --label rollout --wait 20</P$>
            <P$>cast migrate show mg-4k7q2z9a</P$>
          </Term>
          <Caption>Every skip names its reason. <C>--from</C>, <C>--project</C>, <C>--all</C> and short ids select too, and they combine.</Caption>
        </div>
        <div className="space-y-5">
          <Divider />
          <Note>
            Every ownership flip writes that divider into the thread, and the agent is told which machine it is on now. Messages you sent during the move were held by the fence and arrive on the destination.
          </Note>
          <Note>
            One session at a time: <C>cast remote move &lt;session&gt;</C> to the host, <C>cast remote back &lt;session&gt;</C> to return it, as a fast forward that never overwrites local work. <C>cast pull &lt;session&gt;</C> runs any session you can access on this machine.
          </Note>
        </div>
      </div>
    </>
  );
}
