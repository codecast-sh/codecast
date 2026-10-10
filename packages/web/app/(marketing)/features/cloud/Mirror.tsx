"use client";

import { SOL } from "../../blog/blogChrome";
import { BLUE, C, LAPTOP, Note, Out, P$, Pane, SESSION, Term } from "./kit";

const STAYED: { path: string; why: string }[] = [
  { path: "node_modules/", why: "each machine builds its own" },
  { path: "fixtures/demo.mp4", why: "audio and video" },
  { path: "data/dump.sql.gz", why: "over 100 MB" },
];

const RULES: { title: string; body: React.ReactNode }[] = [
  { title: "Everything travels", body: <>Gitignored files too. What stays put: dependency and build folders, media, compiled programs, files over 100 MB, files a running process owns, nested repos.</> },
  { title: "Only the conflicting files hold", body: <>When both sides change the same lines, just those files pause, each side keeps its version, and you pick one. The rest keeps flowing.</> },
  { title: "Nothing lands mid-edit", body: <>A change applies only if its folder has not changed since it was read. Otherwise the sync retries a moment later.</> },
  { title: "The host still sleeps", body: <>The sync talks to the host only while the session works. An edit you make while it idles goes over once it is awake, and never wakes it.</> },
];

/** The session's sync chip, opened: what is in step, what stayed home, what is held. */
function SyncChip() {
  return (
    <Pane
      machine="laptop"
      title={<>session {SESSION} · sync chip</>}
      right={<span className="inline-flex items-center gap-1.5" style={{ color: SOL.cyan }}><span className="w-1.5 h-1.5 rounded-full cl-breathe" style={{ backgroundColor: SOL.cyan }} />syncing</span>}
      bodyClassName="p-0"
    >
      <div className="px-5 pt-4 pb-3">
        <div className="font-mono text-[13px] font-semibold" style={{ color: SOL.base02 }}>Synced with {LAPTOP}</div>
        <div className="font-mono text-[11.5px] mt-1" style={{ color: SOL.base1 }}>.codecast/worktrees/sync-{SESSION} · both ways</div>
      </div>

      <div className="px-5 py-3 border-t" style={{ borderColor: "#eee5cc" }}>
        <div className="font-mono text-[11.5px] mb-2" style={{ color: SOL.orange }}>held: changed on both sides</div>
        <div className="font-mono text-[12.5px] mb-2.5" style={{ color: SOL.base02 }}>src/config/routes.ts</div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="cl-lift font-mono text-[11.5px] px-2.5 py-1 rounded-md border" style={{ borderColor: SOL.base1, color: SOL.base01, backgroundColor: SOL.base3 }}>Keep the laptop&apos;s</button>
          <button type="button" className="cl-lift font-mono text-[11.5px] px-2.5 py-1 rounded-md" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>Keep the cloud&apos;s</button>
        </div>
      </div>

      <div className="px-5 py-3 border-t" style={{ borderColor: "#eee5cc" }}>
        <div className="font-mono text-[11.5px] mb-2" style={{ color: SOL.base1 }}>stayed on the host</div>
        <ul className="space-y-1">
          {STAYED.map((s) => (
            <li key={s.path} className="flex gap-3 font-mono text-[12px]">
              <span style={{ color: SOL.base02 }}>{s.path}</span>
              <span className="ml-auto text-right" style={{ color: SOL.base1 }}>{s.why}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-5 py-3 border-t flex items-center gap-3 font-mono text-[11.5px]" style={{ borderColor: "#eee5cc", backgroundColor: "rgba(238,232,213,.5)", color: SOL.base01 }}>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] border flex items-center justify-center" style={{ borderColor: SOL.base1 }} />Cloud to laptop only</span>
        <span className="ml-auto" style={{ color: BLUE }}>Stop syncing</span>
      </div>
    </Pane>
  );
}

export function MirrorSection() {
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
        <div>
          <SyncChip />
          <Note className="mt-5">
            Open the machine menu in a cloud session&apos;s header and pick <b style={{ color: SOL.base02 }}>Sync with {LAPTOP}</b>, under &ldquo;Keep a copy on a laptop, in step&rdquo;. The agent&apos;s edits land in the laptop copy within a few seconds; your edits there reach the agent the same way. A sync chip in the header then shows what is held and what stayed put; <b style={{ color: SOL.base02 }}>Cloud to laptop only</b> sends changes one way. From a terminal, <C>cast remote sync {SESSION}</C> does the same.
          </Note>
        </div>
        <div className="space-y-4">
          {RULES.map((r) => (
            <div key={r.title} className="rounded-xl border p-5" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
              <div className="font-mono font-semibold text-[14.5px]" style={{ color: SOL.base03 }}>{r.title}</div>
              <p className="mt-1.5 text-[14.5px] leading-6" style={{ color: SOL.base01 }}>{r.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-14 grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
        <Term machine="host" label={`the agent on the host · ${SESSION}`}>
          <Out tone={SOL.base01}># the same verbs, carried out by your laptop</Out>
          <P$ host>cast sync status</P$>
          <P$ host>cast sync pull .env.local ~/data/export.csv</P$>
          <P$ host>cast sync pull --ref feature-x</P$>
          <Out tone={SOL.base01}>  → laptop/feature-x</Out>
          <P$ host>cast sync diff src/app.ts</P$>
          <P$ host>cast sync push</P$>
        </Term>
        <div className="space-y-4">
          <Note>
            <b style={{ color: SOL.base02 }}>When something is missing on the host</b>, the agent there asks for it. <C>cast sync pull</C> fetches named files, including ones that stayed home or live outside the repo, and <C>--ref</C> brings a branch only your laptop has.
          </Note>
          <Note>
            Tune a repo in <C>.codecast/workspace.toml</C>: <C>[sync] always = [&quot;fixtures/big.bin&quot;]</C> travels where a default would skip it, <C>never = [&quot;data/local.db&quot;]</C> stays on its own machine.
          </Note>
        </div>
      </div>
    </>
  );
}
