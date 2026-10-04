"use client";

import { SOL } from "../../blog/blogChrome";
import { BLUE, C, Caption, HOST, Note, Out, P$, Pane, SESSION, Term } from "./kit";

/** [host] table: what a repo needs on the box beyond the tools step. */
export function HostSetupSection() {
  return (
    <div className="grid lg:grid-cols-[1.05fr_1fr] gap-8 items-start">
      <div>
        <Pane machine="laptop" title=".codecast/workspace.toml" bodyClassName="overflow-x-auto">
          <pre className="p-4 font-mono text-[12.5px] leading-[1.8]" style={{ color: SOL.base00 }}>
            <span style={{ color: SOL.blue }}>[setup]</span>{"\n"}
            copy = [<span style={{ color: SOL.cyan }}>&quot;.env.local&quot;</span>]{"   "}<span style={{ color: SOL.base1 }}># rsynced into each worktree</span>{"\n\n"}
            <span style={{ color: SOL.blue }}>[host]</span>{"\n"}
            packages = [<span style={{ color: SOL.cyan }}>&quot;postgresql&quot;</span>, <span style={{ color: SOL.cyan }}>&quot;redis-server&quot;</span>]{"   "}<span style={{ color: SOL.base1 }}># apt</span>{"\n"}
            services = [<span style={{ color: SOL.cyan }}>&quot;redis-server&quot;</span>, <span style={{ color: SOL.cyan }}>&quot;postgresql&quot;</span>]{"   "}<span style={{ color: SOL.base1 }}># systemd, enabled + started</span>{"\n"}
            run = [<span style={{ color: SOL.cyan }}>&quot;sudo -u postgres createuser -s ubuntu || true&quot;</span>]{"\n\n"}
            <span style={{ color: SOL.blue }}>[sync]</span>{"\n"}
            never = [<span style={{ color: SOL.cyan }}>&quot;data/local.db&quot;</span>]
          </pre>
        </Pane>
        <Caption>Personal needs go in <C>~/.codecast/host.toml</C>, same shape. Each <C>run</C> step must be safe to run twice.</Caption>
      </div>
      <div className="space-y-5">
        <Note>
          <b style={{ color: SOL.base02 }}>It converges on every wake.</b> The spec is applied once per change, before any worktree is made, so a brand new host and an edited spec end up in the same place. A failing step is reported with its output and retried next wake. It never blocks a session.
        </Note>
        <Note>
          <b style={{ color: SOL.base02 }}>Save a ready host as an image.</b> <C>cast hosts image</C> captures it; <C>cast hosts create</C> without <C>--image</C> then starts the next host with packages, tools, checkout and mirrored home already there. The clone gives itself a new machine id and signs in as itself on first boot.
        </Note>
        <Note>
          <b style={{ color: SOL.base02 }}>Scripts can tell where they are.</b> Hooks and scripts see <C>$CODECAST_CLOUD</C> set to <C>1</C> on a host. Apply by hand with <C>cast hosts setup</C>; <C>cast hosts ls</C> shows whether each host is in step.
        </Note>
      </div>
    </div>
  );
}

/** The browser on a box with no screen of yours. */
export function BrowserSection() {
  return (
    <div className="grid lg:grid-cols-[1fr_1fr] gap-8 items-start">
      <div className="space-y-5">
        <Term machine="host" label={`${HOST} · ${SESSION}`}>
          <P$ host>cast browser target</P$>
          <Out tone={SOL.base1}>host</Out>
          <Out tone={SOL.base01}># the host&apos;s own Chrome, on its virtual display</Out>
          <P$ host>cast browser open https://dashboard.stripe.com</P$>
          <Out tone={SOL.base01}># a sign-in wall: borrow the laptop&apos;s login</Out>
          <P$ host>cast browser sync dashboard.stripe.com</P$>
          <P$ host>cast browser read</P$>
        </Term>
      </div>
      <div className="space-y-5">
        <Note dark>
          On a host, <C dark>cast browser</C> drives the host&apos;s own Chrome on a virtual display. There is no Chrome of yours there, so <C dark>cast browser sync &lt;site&gt;</C> asks your online laptop to carry that site&apos;s cookies in over an SSH forward. <C dark>--wait</C> sets how long to wait for the laptop (150 seconds by default). Google logins are never carried.
        </Note>
        <Note dark>
          The browser watch beside the conversation streams the agent&apos;s tab with its cursor and clicks drawn on top. Take the wheel to sign into an OAuth page the agent cannot pass. For a popup, a file picker or a Chrome dialog, <C dark>cast hosts vnc</C> opens the host&apos;s whole display in a pane, with mouse, keyboard and clipboard.
        </Note>
        <Note dark>
          These views reach the host through the laptop that manages it, over the SSH connection it already holds. An idle listener closes after 10 minutes, so an open tab does not keep a host awake.
        </Note>
      </div>
    </div>
  );
}

const SLEEP: { k: string; v: React.ReactNode }[] = [
  { k: "Idle stop", v: <>A provisioned Linux host stops itself after 20 idle minutes. <C>cast hosts provision --idle &lt;minutes&gt;</C> changes it; 0 disables.</> },
  { k: "What counts as busy", v: <>Waiting work, open turns, recent subagent activity, live task processes, detached tmux work, CPU. Unreadable evidence keeps it awake. An idle prompt does not.</> },
  { k: "Quiet jobs", v: <><C>cast hosts keepalive 30</C> on the host holds it up for 1 to 1440 minutes. A shorter lease never cancels a longer one.</> },
  { k: "Waking", v: <>Work queued for a sleeping host is picked up by your laptop daemon, which boots it. The session resumes from the worktree and transcript on the host&apos;s disk.</> },
  { k: "Macs", v: <>AWS Macs run on dedicated hosts: 24 hour minimum allocation, and stopping the instance does not end the charges. Mac auto-stop is off.</> },
];

export function SleepSection() {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-[1fr_1fr] gap-x-10 gap-y-0 rounded-2xl border overflow-hidden" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
      {SLEEP.map((s, i) => (
        <div key={s.k} className={`px-6 py-5 ${i < SLEEP.length - 1 ? "border-b" : ""} ${i === SLEEP.length - 1 ? "md:col-span-2" : ""}`} style={{ borderColor: "#eee5cc" }}>
          <div className="font-mono text-[13px] font-semibold" style={{ color: BLUE }}>{s.k}</div>
          <p className="mt-1.5 text-[14.5px] leading-6" style={{ color: SOL.base01 }}>{s.v}</p>
        </div>
      ))}
    </div>
  );
}
