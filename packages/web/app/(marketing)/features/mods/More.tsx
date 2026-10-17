"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Command, Flame, Inbox, LayoutGrid, ListChecks, Lock, MonitorSmartphone, Puzzle, Search, Terminal } from "lucide-react";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { ForScripts, Shot } from "../kit";
import { DIM, LINE, MUTED, TEXT, V, at, tint } from "./theme";
import { AppFrame, C, Code, Section } from "./kit";
import { Pill, StatusBadge } from "./objects";
import { INC6, INC7, incident } from "./data";
import { Spark, Stat } from "./blocks";

/* ── 9. Surfaces ─────────────────────────────────────────────────────────── */

function Num({ n, className = "" }: { n: number; className?: string }) {
  return <span className={`inline-grid place-items-center w-5 h-5 rounded-full font-mono text-[11px] font-bold shrink-0 ${className}`} style={{ backgroundColor: V, color: SOL.base3 }}>{n}</span>;
}

const INC9 = incident(9, "Login emails delayed", "triage", [["severity", "sev-3"]]);
const INC5 = incident(5, "Image CDN 404s in eu-west", "monitoring", [["severity", "sev-2"]]);

const SURFACES: { n: number; title: string; where: string; what: ReactNode }[] = [
  { n: 1, title: "Sidebar sections", where: "under the app's nav", what: "A titled section the mod draws, like the open incidents with their live state." },
  { n: 2, title: "Panes", where: "a tab, or one cell of a split", what: "A whole screen, drawn from your store, filled the instant it opens." },
  { n: 3, title: "Palette commands", where: "a Mods group in the command palette", what: "Open a pane, or run in place. A failure shows as a toast." },
  { n: 4, title: "Themes", where: "Settings, Appearance", what: "A palette for light and dark that recolors the whole app." },
];

function SurfacesMock() {
  const sidebar = [INC9, INC7, INC5];
  return (
    <AppFrame title="codecast" className="relative">
      <div className="grid grid-cols-[150px_minmax(0,1fr)] sm:grid-cols-[180px_minmax(0,1fr)] min-h-[380px]">
        <aside className="border-r p-2.5 text-[12px] space-y-0.5 rounded-bl-xl" style={{ borderColor: LINE, backgroundColor: "rgba(238,232,213,.35)" }}>
          {[[Inbox, "Inbox"], [ListChecks, "Tasks"], [LayoutGrid, "Plans"]].map(([I, l]) => {
            const Icon = I as typeof Inbox;
            return <div key={l as string} className="flex items-center gap-2 px-2 py-1 rounded" style={{ color: MUTED }}><Icon className="w-3.5 h-3.5" />{l as string}</div>;
          })}
          <div className="pt-3 relative">
            <div className="flex items-center gap-1.5 px-2 mb-1 text-[10.5px] font-medium" style={{ color: DIM }}>Open incidents <Num n={1} className="ml-auto scale-90" /></div>
            {sidebar.map((o) => (
              <div key={o.id} className="flex items-center gap-1.5 px-2 py-1 rounded text-[11.5px]" style={{ color: TEXT }}>
                <Flame className="w-3 h-3 shrink-0" style={{ color: o.iconTone }} />
                <span className="truncate">{o.title}</span>
              </div>
            ))}
          </div>
        </aside>
        <div className="relative p-4 min-w-0">
          <div className="flex items-center gap-2 mb-3">
            <Puzzle className="w-3.5 h-3.5" style={{ color: V }} />
            <span className="text-[13px] font-semibold" style={{ color: TEXT }}>Incident desk</span>
            <span className="text-[10.5px] font-mono" style={{ color: DIM }}>v3 · r12</span>
            <Num n={2} className="ml-auto" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="open" value="3" />
            <Stat label="sev-2 or worse" value="2" tone={SOL.orange} />
            <Stat label="median to resolve" value="38m" />
          </div>
          <div className="mt-3 rounded-md border" style={{ borderColor: LINE }}>
            {[INC7, INC5, INC9, INC6].map((o) => (
              <div key={o.id} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 border-b last:border-b-0 text-[11.5px]" style={{ borderColor: LINE }}>
                <span className="font-mono" style={{ color: DIM }}>{o.id}</span>
                <span className={`truncate ${o.done ? "line-through opacity-60" : ""}`} style={{ color: TEXT }}>{o.title}</span>
                <StatusBadge label={o.state!.label} color={o.state!.color} />
              </div>
            ))}
          </div>
          {/* the palette, open over the pane */}
          <div className="absolute right-3 w-[78%] sm:w-[64%] top-[214px] rounded-lg border overflow-hidden" style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 30px 60px -20px rgba(0,43,54,.45)" }}>
            <div className="flex items-center gap-2 px-3 h-9 border-b text-[12.5px]" style={{ borderColor: LINE, color: TEXT }}>
              <Search className="w-3.5 h-3.5" style={{ color: DIM }} />incident<span className="w-[1.5px] h-4 animate-pulse" style={{ backgroundColor: V }} />
              <Num n={3} className="ml-auto" />
            </div>
            <div className="px-3 pt-2 pb-1 text-[10px] font-medium" style={{ color: DIM }}>Mods</div>
            {[["Incident desk", "Open board", true], ["Incident desk", "Declare an incident", false], ["Releases", "Promote canary on payments-api", false]].map(([m, c, on]) => (
              <div key={c as string} className="flex items-center gap-2 px-3 py-1.5 text-[12px]" style={{ backgroundColor: on ? tint(V, 10) : undefined, color: TEXT }}>
                <Command className="w-3 h-3" style={{ color: V }} /><span style={{ color: DIM }}>{m as string}</span><span>{c as string}</span>
              </div>
            ))}
            <div className="h-1.5" />
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

export function Surfaces() {
  return (
    <Section
      id="surfaces"
      title="Panes, commands, sidebar sections and themes"
      lede={<>The same mod can give your team a screen of its own. A pane is a full page drawn with codecast's own cards, tables, stats and charts. It reads your sessions, tasks, plans and pull requests from the app's local store, so it fills instantly and updates as sessions move, with no server of your own behind it.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] gap-8 items-start">
        <SurfacesMock />
        <ul className="space-y-5">
          {SURFACES.map((s) => (
            <li key={s.n} className="grid grid-cols-[24px_1fr] gap-3">
              <Num n={s.n} className="mt-0.5" />
              <div>
                <div className="text-[15px] font-semibold" style={{ color: TEXT }}>{s.title} <span className="font-normal text-[12.5px]" style={{ color: DIM }}>{s.where}</span></div>
                <p className="text-[14px] leading-6 mt-0.5" style={{ color: MUTED }}>{s.what}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <Shot
        className="mt-14 max-w-4xl"
        src="/blog/field-manual/mods-pane.webp"
        alt="The Fleet Pulse mod open as a pane in codecast: four stat tiles over a table of sessions waiting on the viewer"
        width={1800}
        height={1380}
        caption={<>A real one: Fleet Pulse, a small mod running as a tab. Its tiles and the <b style={{ color: TEXT, fontWeight: 600 }}>Waiting on you</b> table read straight from the local store.</>}
      />
    </Section>
  );
}

/* ── 10. Built in the thread ─────────────────────────────────────────────── */

const REVS = [
  { t: 0.6, r: 1, say: "Make me an incident desk: open incidents, who is commander, how long each has run." },
  { t: 2.2, r: 2, say: "Group it by service and show each severity." },
  { t: 3.8, r: 3, say: "Add the error rate for each service over the last hour." },
];

function PaneEmbed() {
  const rows = [
    { svc: "payments-api", o: INC7, cmd: "Dana", age: "41m", sev: "sev-2", spark: [0.1, 0.2, 4.8, 6.1, 5.9, 2.2, 0.6, 0.3] },
    { svc: "cdn", o: INC5, cmd: "Sam", age: "2h 10m", sev: "sev-2", spark: [1.2, 1.4, 1.1, 0.9, 0.6, 0.4, 0.3, 0.3] },
    { svc: "auth", o: INC9, cmd: "Lee", age: "6m", sev: "sev-3", spark: [0.2, 0.2, 0.3, 0.2, 0.4, 0.6, 0.7, 0.9] },
  ];
  const last = REVS[REVS.length - 1];
  return (
    <div className="md-flash rounded-xl border overflow-hidden" style={at(last.t + 0.4, { borderColor: tint(V, 35), backgroundColor: tint(V, 6) })}>
      <div className="h-9 px-3 flex items-center gap-2 border-b text-[12px]" style={{ borderColor: tint(V, 20) }}>
        <Puzzle className="w-3.5 h-3.5" style={{ color: V }} />
        <span className="font-semibold" style={{ color: TEXT }}>Incident desk</span>
        <span className="font-mono text-[10.5px] inline-grid" style={{ color: DIM }}>
          {REVS.map((r, i) => (
            <span key={r.r} className={`[grid-area:1/1] ${i < REVS.length - 1 ? "md-gone" : "md-tick"}`} style={at(i < REVS.length - 1 ? REVS[i + 1].t + 0.4 : r.t + 0.4)}>r{r.r}</span>
          ))}
        </span>
        <span className="ml-auto flex gap-3 text-[11px]" style={{ color: MUTED }}><span>Logs</span><span>Open</span></span>
      </div>
      <div className="p-3" style={{ backgroundColor: "#fffdf6" }}>
        <div className="md-in grid grid-cols-3 gap-1.5 mb-3" style={at(REVS[0].t + 0.4)}>
          <Stat label="open" value="3" />
          <Stat label="sev-2 or worse" value="2" tone={SOL.orange} />
          <Stat label="longest running" value="2h 10m" />
        </div>
        <div className="hidden sm:grid grid-cols-[120px_minmax(0,1fr)_64px_60px_90px] gap-2 px-0.5 pb-1.5 mb-1 border-b text-[10px] font-mono" style={{ borderColor: LINE, color: DIM }}>
          <span>service</span><span>incident</span><span>commander</span><span>running</span><span>errors, 1h</span>
        </div>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.svc} className="md-in grid grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_70px] sm:grid-cols-[120px_minmax(0,1fr)_64px_60px_90px] items-center gap-2 text-[11.5px]" style={at(REVS[1].t + 0.5 + i * 0.08)}>
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono truncate" style={{ color: MUTED }}>{r.svc}</span>
                <span className="md-in shrink-0 rounded-full px-1.5 text-[9.5px] font-medium" style={at(REVS[1].t + 0.6, { color: r.sev === "sev-2" ? SOL.orange : SOL.yellow, backgroundColor: tint(r.sev === "sev-2" ? SOL.orange : SOL.yellow, 12) })}>{r.sev}</span>
              </span>
              <span className="truncate"><Pill o={r.o} /></span>
              <span className="hidden sm:block" style={{ color: TEXT }}>{r.cmd}</span>
              <span className="hidden sm:block tabular-nums" style={{ color: DIM }}>{r.age}</span>
              <span className="md-in" style={at(last.t + 0.5 + i * 0.1)}><Spark points={r.spark} color={r.sev === "sev-2" ? SOL.orange : SOL.yellow} height={18} d={last.t + 0.6} /></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Thread() {
  return (
    <Section
      id="thread"
      tone="sand"
      title="Build a mod by asking for it"
      lede={<>Describe the mod in the conversation; your agent builds it and pushes, and the running pane appears in the thread. Each change you ask for lands in place: the header flashes and the revision ticks up. It is live in your app seconds after each push, with no deploy.</>}
      aside={<>A pane that fails to draw shows <b style={{ color: TEXT, fontWeight: 600 }}>Try again</b> in its own spot, a failed redraw keeps the last good drawing, and the agent reads the same <b style={{ color: TEXT, fontWeight: 600 }}>Logs</b> you do.</>}
    >
      <AppFrame title="Incident desk mod · ops">
        <div className="p-4 sm:p-6 grid lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] gap-6 items-start">
          <div className="space-y-4">
            {REVS.map((r) => (
              <div key={r.r} className="md-in space-y-2" style={at(r.t)}>
                <div className="ml-auto max-w-[92%] w-fit rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] leading-6" style={{ backgroundColor: "rgba(38,139,210,.1)", color: TEXT }}>{r.say}</div>
                <div className="text-[13px] font-mono flex items-center gap-2" style={{ color: MUTED }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />
                  pushed <span style={{ color: V }}>r{r.r}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="lg:sticky lg:top-24"><PaneEmbed /></div>
        </div>
      </AppFrame>
      <div className="mt-8 grid sm:grid-cols-4 gap-3">
        {[["Describe", "what you want, in the thread"], ["Push", "live in your app in seconds"], ["Steer", "each change redraws in place"], ["Publish", "a numbered version with its source"]].map(([a, b], i) => (
          <div key={a} className="rounded-lg border px-3.5 py-3" style={{ borderColor: LINE, backgroundColor: SOL.base3 }}>
            <div className="flex items-center gap-2"><span className="font-mono text-[11px]" style={{ color: V }}>{i + 1}</span><span className="text-[14px] font-semibold" style={{ color: TEXT }}>{a}</span></div>
            <div className="text-[12.5px] mt-1 leading-5" style={{ color: MUTED }}>{b}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── 11. The local half ──────────────────────────────────────────────────── */

const LOCAL = `on("local.start", ($) => {
  $.every(10_000, async () => {
    const { stdout } = await $.sh("tail -n 2000 /var/log/payments/api.log");
    const lines = stdout.split("\\n");
    const errors = lines.filter((l) => l.includes(" 502 ")).length;
    $.publish("payments.errors", errors);
    if (errors > 50) await $.objects.create({
      prefix: "inc", title: "payments-api 502s on " + $.device,
      fields: { severity: "sev-2", service: "payments-api" },
    });
  });
});`;

export function Local() {
  return (
    <Section
      id="local"
      title="Read data from your own machines"
      lede={<>Some facts live on a laptop or a server: a log file, a running process, a GPU, a local database. A mod's local half runs in the codecast daemon on your own machines, reads what they can read, and publishes values its panes and blocks draw from. It can file objects too, so a spike in a log becomes an incident on the board.</>}
      aside={<>A local half runs only where a person approved that exact version, by typing the mod's name in a terminal on that machine. Agents are told they cannot approve their own, and a new version waits for a new approval.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] gap-6 items-center">
        <Code file="incident-desk / local.ts" code={LOCAL} mark={[3, 6]} size={12} />
        <div className="space-y-3">
          {[["build-box", "Linux · approved v3", 3], ["dana-mbp", "macOS · approved v3", 0], ["sam-mbp", "macOS · not approved", null]].map(([name, sub, n]) => (
            <div key={name as string} className="rounded-xl border px-4 py-3 flex items-center gap-3" style={{ borderColor: LINE, backgroundColor: "#fffdf6", opacity: n === null ? 0.55 : 1 }}>
              <MonitorSmartphone className="w-4 h-4 shrink-0" style={{ color: n === null ? DIM : V }} />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px]" style={{ color: TEXT }}>{name as string}</div>
                <div className="text-[11.5px]" style={{ color: MUTED }}>{sub as string}</div>
              </div>
              {n === null ? <Lock className="w-3.5 h-3.5" style={{ color: DIM }} /> : (
                <div className="text-right">
                  <div className="font-mono text-[15px] font-semibold tabular-nums" style={{ color: (n as number) > 0 ? SOL.orange : SOL.green }}>{n as number}</div>
                  <div className="text-[10.5px]" style={{ color: DIM }}>502s in 10s</div>
                </div>
              )}
            </div>
          ))}
          <div className="rounded-xl border px-4 py-3 font-mono text-[12px]" style={{ borderColor: LINE, backgroundColor: SOL.base03, color: SOL.base1 }}>
            <span style={{ color: SOL.green }}>$ </span>cast mod approve incident-desk
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 12. Trust ───────────────────────────────────────────────────────────── */

const GRANTS: { k: string; v: ReactNode }[] = [
  { k: "reads", v: <>sessions, tasks, pull requests</> },
  { k: "writes", v: <>incidents (its own kind), tasks</> },
  { k: "fetches", v: <C>deploy.acme.dev</C> },
  { k: "secrets", v: <>deploy, kept on the server</> },
];

export function Trust() {
  return (
    <Section
      id="trust"
      tone="sand"
      title="Each mod reaches only what it was granted"
      lede={<>Each mod runs in a locked-down frame of its own, with no access to the page around it. Its manifest says what it reads, what it writes and which sites it may call, and every read and write is checked against that. Building a mod fails on code that reaches past its grants, and names the grant it would need.</>}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-3 gap-5">
        <div className="md:col-span-2 rounded-xl border p-5" style={{ borderColor: LINE, backgroundColor: SOL.base3 }}>
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg grid place-items-center" style={{ backgroundColor: tint(V, 14) }}><Flame className="w-4.5 h-4.5" style={{ color: V }} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold" style={{ color: TEXT }}>Incident desk</div>
              <div className="text-[12px]" style={{ color: MUTED }}>Shared by Dana · v3 · panes, a block, the inc kind</div>
            </div>
            <span className="rounded-md px-3 py-1.5 text-[12.5px] font-semibold" style={{ backgroundColor: V, color: SOL.base3 }}>Install</span>
          </div>
          <dl className="mt-5 grid sm:grid-cols-2 gap-x-6 gap-y-2.5">
            {GRANTS.map((g) => (
              <div key={g.k} className="flex gap-3 text-[13.5px]"><dt className="w-16 shrink-0 font-mono text-[12px] pt-0.5" style={{ color: DIM }}>{g.k}</dt><dd style={{ color: TEXT }}>{g.v}</dd></div>
            ))}
          </dl>
          <div className="mt-5 pt-4 border-t flex items-center gap-3 text-[13px]" style={{ borderColor: LINE }}>
            <span className="rounded-md px-3 py-1.5 text-[12.5px] font-semibold border" style={{ borderColor: SOL.yellow, color: SOL.yellow, backgroundColor: tint(SOL.yellow, 8) }}>Grants changed: review</span>
            <span style={{ color: MUTED }}>what you see if v4 asks to read more</span>
          </div>
        </div>
        <ul className="space-y-4 text-[14px] leading-6" style={{ color: MUTED }}>
          <li><b style={{ color: TEXT, fontWeight: 600 }}>A teammate's mod runs for you</b> only after you press Install, at the grants on its card.</li>
          <li><b style={{ color: TEXT, fontWeight: 600 }}>Keys never reach a browser.</b> Requests that need one are sent from codecast's server.</li>
          <li><b style={{ color: TEXT, fontWeight: 600 }}>It writes only the kinds it owns,</b> and sees your name, never your email.</li>
          <li><b style={{ color: TEXT, fontWeight: 600 }}>Every version keeps its source:</b> readable, diffable, one step to roll back.</li>
        </ul>
      </div>
    </Section>
  );
}

/* ── 13. Reference ───────────────────────────────────────────────────────── */

const REFERENCE: [string, string][] = [
  ["cast mod new <name>", "a working scaffold: a pane, a command and a block"],
  ["cast mod build", "bundle, typecheck, and check the code against its grants"],
  ["cast mod push", "live in the app within seconds; prints the pane's link"],
  ["cast mod logs <name>", "what it printed and threw while drawing"],
  ["cast mod publish -m <note>", "a numbered version with its source"],
  ["cast mod rollback <name>", "back to an earlier version"],
  ["cast mod guide", "what every running mod asks of agents"],
  ["cast obj kinds", "every object kind in this workspace"],
  ["cast obj create <prefix> <title>", "file an object, with --set field=value"],
  ["cast obj set <id> status=<s>", "move it along"],
];

export function Reference() {
  return (
    <section style={{ backgroundColor: SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20">
        <ForScripts note={<>Mods are built by agents, so the build loop is a handful of commands. You can run them yourself too.</>}>
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: LINE }}>
            {REFERENCE.map(([cmd, what]) => (
              <div key={cmd} className="grid sm:grid-cols-[minmax(0,320px)_1fr] gap-x-6 gap-y-0.5 px-4 py-2.5 border-b last:border-b-0" style={{ borderColor: LINE }}>
                <code className="font-mono text-[12.5px]" style={{ color: SOL.base02 }}><Terminal className="inline w-3 h-3 mr-1.5 -mt-0.5" style={{ color: V }} />{cmd}</code>
                <span className="text-[13.5px]" style={{ color: MUTED }}>{what}</span>
              </div>
            ))}
          </div>
        </ForScripts>
      </div>
    </section>
  );
}

/* ── Related and install ─────────────────────────────────────────────────── */

const RELATED: { slug: string; why: string }[] = [
  { slug: "publish", why: "For a one-off report or dashboard at a link, publish a page instead of building a mod." },
  { slug: "decisions", why: "A decision is one of the built-in kinds: sd-N renders with its options and your answer." },
  { slug: "pull-requests", why: "Pull requests render inline with checks, reviews and the session that owns them." },
  { slug: "memory", why: "Objects your agents file stay searchable, with the session that filed them." },
];

export function Related() {
  const items = RELATED.map((r) => ({ ...r, f: FEATURE_DEEP_DIVES.find((f) => f.slug === r.slug) })).filter((r) => r.f);
  return (
    <section style={{ backgroundColor: SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 pb-20">
        <h2 className="font-mono font-bold text-[24px] sm:text-[28px] tracking-[-0.03em] mb-8" style={{ color: SOL.base03 }}>Related features</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {items.map(({ slug, why, f }) => (
            <Link key={slug} href={featureHref(slug)} className="md-lift group rounded-xl border p-5 hover:bg-[rgba(238,232,213,.5)]" style={{ borderColor: LINE }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f!.color }} />
                <span className="font-mono font-bold text-[15px] group-hover:underline underline-offset-4" style={{ color: SOL.base02 }}>{f!.name}</span>
              </div>
              <p className="text-[14px] leading-6" style={{ color: SOL.base01 }}>{why}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Cta() {
  return (
    <section id="install" className="scroll-mt-20 relative overflow-hidden" style={{ backgroundColor: SOL.base03 }}>
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "radial-gradient(40rem 24rem at 10% 0%, rgba(108,113,196,.22), transparent 65%)" }} />
      <div className="relative max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 items-center">
        <div>
          <h2 className="font-mono font-bold text-[28px] sm:text-[36px] leading-[1.12] tracking-[-0.03em]" style={{ color: SOL.base3 }}>
            Get started with mods
          </h2>
          <p className="mt-5 text-[16px] leading-7 max-w-lg" style={{ color: SOL.base1 }}>
            Install codecast, open <b style={{ color: SOL.base2 }}>Agent features</b> from your account menu and switch on <b style={{ color: SOL.base2 }}>Mods</b>. Then ask an agent for the first one: the incident desk, the customer lookup, the deploy panel your team keeps asking about.
          </p>
        </div>
        <div className="rounded-xl p-5 sm:p-6" style={{ backgroundColor: SOL.base3 }}>
          <InstallTabs location="feature-mods" />
        </div>
      </div>
    </section>
  );
}
