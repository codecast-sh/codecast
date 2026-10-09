"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { BLUE, HOST, Pane, SESSION, delay } from "./kit";

/** One step the host reports while a cloud spawn prepares it. */
const HOST_STEPS: { text: ReactNode; d: number }[] = [
  { text: <>woke the host <span style={{ color: SOL.base01 }}>stopped → running</span></>, d: 1.9 },
  { text: <>fetched <b className="font-medium" style={{ color: SOL.base2 }}>~/src/shop</b> <span style={{ color: SOL.base01 }}>kept its HEAD</span></>, d: 2.3 },
  { text: <>copied <b className="font-medium" style={{ color: SOL.base2 }}>.env.local</b> <span style={{ color: SOL.base01 }}>setup.copy</span></>, d: 2.7 },
  { text: <>agent logins pushed <span style={{ color: SOL.base01 }}>claude, codex</span></>, d: 3.1 },
  { text: <>worktree <b className="font-medium" style={{ color: SOL.base2 }}>port-v1-routes</b> <span style={{ color: SOL.base01 }}>made on the host</span></>, d: 3.5 },
  { text: <>branch <b className="font-medium" style={{ color: SOL.base2 }}>feature/checkout</b> <span style={{ color: SOL.base01 }}>reset to a41c9e2, v1.ts uncommitted again</span></>, d: 3.9 },
];

/** What the agent on the host does, in order; each edit lands on the laptop a beat later. */
const AGENT: { tool: string; arg: string; out?: string; d: number }[] = [
  { tool: "Read", arg: "src/routes/v1.ts", d: 4.7 },
  { tool: "Write", arg: "src/routes/v2/orders.ts", out: "+84", d: 5.4 },
  { tool: "Edit", arg: "src/routes/v2/index.ts", out: "+12 −3", d: 6.1 },
  { tool: "Bash", arg: "bun test test/v2.test.ts", out: "14 pass", d: 6.8 },
];

/** The laptop's mirror folder; rows with `land` arrive from the host. */
const TREE: { path: string; depth: number; tag?: string; land?: number; dir?: boolean }[] = [
  { path: "src/", depth: 0, dir: true },
  { path: "routes/", depth: 1, dir: true },
  { path: "v1.ts", depth: 2, tag: "M" },
  { path: "v2/", depth: 2, dir: true },
  { path: "index.ts", depth: 3, tag: "+12 −3", land: 6.5 },
  { path: "orders.ts", depth: 3, tag: "+84", land: 5.8 },
  { path: "test/", depth: 0, dir: true },
  { path: "v2.test.ts", depth: 1, tag: "+40", land: 7.1 },
  { path: ".env.local", depth: 0, tag: "gitignored" },
];

function Packet({ d, len, kind, color, n = 1, label }: { d: number; len: number; kind: "out" | "back" | "down" | "up"; color: string; n?: number | "infinite"; label?: string }) {
  const style = { ["--d" as string]: `${d}s`, ["--len" as string]: `${len}s`, ["--pk" as string]: `cl-${kind}`, ["--n" as string]: String(n) } as CSSProperties;
  const horiz = kind === "out" || kind === "back";
  return (
    <span className="cl-packet" style={{ ...style, ...(horiz ? { top: -4 } : { left: -4 }) }}>
      <span className="block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }} />
      {label ? <span className="absolute whitespace-nowrap font-mono text-[10px] left-4 -top-1" style={{ color }}>{label}</span> : null}
    </span>
  );
}

/** The wire between the machines: snapshot out on top, edits back underneath. */
function Wire({ vertical }: { vertical: boolean }) {
  if (vertical) {
    return (
      <div className="lg:hidden relative h-28 flex justify-center gap-16" aria-hidden>
        <div className="relative w-px h-full" style={{ backgroundColor: "rgba(38,139,210,.45)" }}>
          <Packet kind="down" d={1.2} len={1.4} color={BLUE} />
          <span className="absolute top-1/2 -translate-y-1/2 right-3 font-mono text-[11px] whitespace-nowrap" style={{ color: SOL.base01 }}>checkout ↓</span>
        </div>
        <div className="relative w-px h-full" style={{ backgroundColor: "rgba(42,161,152,.45)" }}>
          <Packet kind="up" d={5.4} len={1.3} color={SOL.cyan} n="infinite" />
          <span className="absolute top-1/2 -translate-y-1/2 left-3 font-mono text-[11px] whitespace-nowrap" style={{ color: SOL.base01 }}>↑ edits</span>
        </div>
      </div>
    );
  }
  return (
    <div className="hidden lg:flex flex-col justify-center gap-28 px-2" aria-hidden>
      <div>
        <div className="mb-2.5 flex justify-center"><span className="font-mono text-[11px] px-2 py-0.5 rounded-full border" style={{ color: BLUE, borderColor: "rgba(38,139,210,.45)", backgroundColor: SOL.base3 }}>checkout →</span></div>
        <div className="relative h-[2px] rounded" style={{ backgroundImage: `linear-gradient(90deg, ${BLUE}, rgba(38,139,210,.35))` }}>
          <Packet kind="out" d={1.2} len={1.5} color={BLUE} />
        </div>
      </div>
      <div>
        <div className="relative h-[2px] rounded" style={{ backgroundImage: `linear-gradient(90deg, rgba(42,161,152,.35), ${SOL.cyan})` }}>
          <Packet kind="back" d={5.5} len={1.3} color={SOL.cyan} n="infinite" />
        </div>
        <div className="mt-2.5 flex justify-center"><span className="font-mono text-[11px] px-2 py-0.5 rounded-full border" style={{ color: SOL.cyan, borderColor: "rgba(42,161,152,.5)", backgroundColor: SOL.base03 }}>← edits</span></div>
      </div>
    </div>
  );
}

function LaptopSide() {
  return (
    <div className="space-y-5 min-w-0">
      <Pane machine="laptop" title={<>~/src/shop <span style={{ color: SOL.base1 }}>· feature/checkout</span></>} right={<span style={{ color: SOL.base1 }}>{"your laptop"}</span>}>
        <pre className="font-mono text-[12px] leading-[1.8] overflow-x-auto" style={{ color: SOL.base00 }}>
          <span style={{ color: SOL.base1 }}>uncommitted{"\n"}</span>
          <span style={{ color: SOL.yellow }}>{" M"}</span> src/routes/v1.ts{"\n"}
          <span style={{ color: SOL.red }}>??</span> .env.local <span style={{ color: SOL.base1 }}>(ignored)</span>{"\n"}
          <span className="cl-anim cl-type inline-block" style={delay(0.3)}>
            <span style={{ color: SOL.base1 }}>new session ›</span> <span style={{ color: SOL.base02 }}>port the v1 routes</span>
          </span>{"\n"}
          <span className="cl-anim cl-fade inline-block" style={delay(1.1)}>
            <span style={{ color: SOL.violet }}>● run in the cloud</span> <span style={{ color: SOL.base1 }}>· start from my checkout</span>
          </span>{"\n"}
          <span className="cl-anim cl-fade inline-block" style={delay(1.5)}>
            <span style={{ color: SOL.base1 }}>snapshot a41c9e2 + 1 change → refs/codecast/cloud/…</span>
          </span>{"\n"}
          <span className="cl-anim cl-fade inline-block" style={delay(4.2)}>
            <span style={{ color: BLUE }}>●</span> {SESSION} <span style={{ color: SOL.base1 }}>running on {HOST}</span>
          </span>
        </pre>
      </Pane>

      <Pane
        machine="laptop"
        title={<>.codecast/worktrees/sync-{SESSION}</>}
        right={<span className="inline-flex items-center gap-1.5" style={{ color: SOL.cyan }}><span className="w-1.5 h-1.5 rounded-full cl-breathe" style={{ backgroundColor: SOL.cyan }} />in step</span>}
        bodyClassName="py-2"
      >
        <ul className="font-mono text-[12px]">
          {TREE.map((r) => (
            <li
              key={r.path + r.depth}
              className={`flex items-center gap-2 py-[3px] pr-4 ${r.land ? "cl-anim cl-land" : ""}`}
              style={{ ...(r.land ? delay(r.land) : {}), paddingLeft: 16 + r.depth * 16 }}
            >
              <span style={{ color: r.dir ? SOL.base01 : SOL.base02 }}>{r.path}</span>
              {r.tag ? (
                <span className="ml-auto text-[11px]" style={{ color: r.tag.startsWith("+") ? SOL.green : r.tag === "M" ? SOL.yellow : SOL.base1 }}>
                  {r.tag}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Pane>
    </div>
  );
}

function HostSide() {
  return (
    <div className="space-y-5 min-w-0">
      <Pane
        machine="host"
        title={<>{HOST} <span style={{ color: SOL.base01 }}>· linux · aws</span></>}
        right={<span className="inline-flex items-center gap-1.5" style={{ color: SOL.green }}><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />awake</span>}
      >
        <ul className="font-mono text-[12px] leading-[1.75] space-y-0.5" style={{ color: SOL.base0 }}>
          {HOST_STEPS.map((s, i) => (
            <li key={i} className="flex gap-2.5 cl-anim cl-rise" style={delay(s.d)}>
              <span className="cl-anim cl-tick shrink-0" style={delay(s.d + 0.15, { color: SOL.green })}>✓</span>
              <span className="min-w-0">{s.text}</span>
            </li>
          ))}
        </ul>
      </Pane>

      <Pane machine="host" title={<>claude · {SESSION}</>} right={<span style={{ color: SOL.base01 }}>worktree port-v1-routes</span>}>
        <div className="font-mono text-[12px] leading-[1.75] space-y-1">
          <div className="cl-anim cl-rise" style={delay(4.3, { color: SOL.base1 })}>
            <span style={{ color: SOL.base2 }}>&gt;</span> port the v1 routes
          </div>
          {AGENT.map((a) => (
            <div key={a.arg} className="flex gap-2 cl-anim cl-rise min-w-0" style={delay(a.d)}>
              <span style={{ color: BLUE }}>●</span>
              <span style={{ color: SOL.base2 }}>{a.tool}</span>
              <span className="truncate min-w-0" style={{ color: SOL.base0 }}>{a.arg}</span>
              {a.out ? <span className="ml-auto shrink-0" style={{ color: SOL.green }}>{a.out}</span> : null}
            </div>
          ))}
          <div className="cl-anim cl-fade pt-1" style={delay(7.4, { color: SOL.base01 })}>
            <span className="cl-caret" />
          </div>
        </div>
      </Pane>
    </div>
  );
}

/** The signature visual: laptop on paper, host at night, the wire between. */
export function HeroDiptych() {
  return (
    <div className="relative">
      <div className="hidden lg:block absolute inset-y-0 right-0 w-1/2 cl-night" aria-hidden />
      <div className="relative max-w-6xl mx-auto px-5 sm:px-8 lg:grid lg:grid-cols-[1fr_110px_1fr]">
        <div className="pt-4 pb-0 lg:py-16 lg:pr-2"><LaptopSide /></div>
        <Wire vertical={false} />
        <Wire vertical />
        <div className="cl-night -mx-5 px-5 sm:-mx-8 sm:px-8 py-10 lg:!bg-none lg:!bg-transparent lg:mx-0 lg:px-0 lg:py-16 lg:pl-6">
          <HostSide />
          <p className="mt-5 font-mono text-[11.5px] leading-5" style={{ color: SOL.base01 }}>One cloud session, condensed: your laptop on the left, your host on the right, one conversation throughout.</p>
        </div>
      </div>
    </div>
  );
}
