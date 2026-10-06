"use client";

// A small picture of what each agent feature looks like once it is on: the
// surface it adds, drawn from the app's own tokens with made-up content. Theme
// aware, crisp at any size, and free of anyone's real sessions or names, so
// the same picture serves the Agent features page, its detail view and the
// upsells across the app.

import type { ReactNode } from "react";
import { ArrowRight, Check, Circle, Lock, Play } from "lucide-react";
import { featureTone, type Tone } from "./featureLook";

export function FeatureVignette({ slug, className = "" }: { slug: string; className?: string }) {
  const draw = VIGNETTES[slug];
  if (!draw) return null;
  return (
    <div
      aria-hidden
      className={`relative overflow-hidden rounded-md border border-sol-border/60 bg-sol-bg-alt/50 font-mono text-[10px] leading-tight text-sol-text-muted select-none ${className}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,var(--sol-border)_1px,transparent_0)] [background-size:14px_14px] opacity-40" />
      <div className="relative flex h-full w-full items-center justify-center p-3">{draw(featureTone(slug))}</div>
    </div>
  );
}

// ------------------------------------------------------------------ primitives

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded border border-sol-border/70 bg-sol-bg shadow-sm ${className}`}>{children}</div>;
}

/** A line of text too small to read: the shape of prose, not its content. */
function Bar({ w, className = "" }: { w: string; className?: string }) {
  return <span className={`block h-[5px] rounded-full bg-sol-text-dim/25 ${className}`} style={{ width: w }} />;
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${className}`} />;
}

function Term({ lines, t }: { lines: [string, string?][]; t: Tone }) {
  return (
    <Panel className="w-full max-w-[260px] overflow-hidden">
      <div className="flex gap-1 border-b border-sol-border/60 px-2 py-1.5">
        <Dot className="bg-sol-red/50" />
        <Dot className="bg-sol-yellow/50" />
        <Dot className="bg-sol-green/50" />
      </div>
      <div className="space-y-1 px-2.5 py-2">
        {lines.map(([cmd, out], i) => (
          <div key={i}>
            {cmd && (
              <div className="truncate text-sol-text">
                <span className={t.text}>$ </span>
                {cmd}
              </div>
            )}
            {out && <div className="truncate text-sol-text-muted">{out}</div>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** One session as it sits in the inbox: a status dot, a title, a meta line. */
function SessionRow({ title, dot, meta, children }: { title: string; dot: string; meta?: string; children?: ReactNode }) {
  return (
    <Panel className="px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <Dot className={dot} />
        <span className="truncate text-sol-text">{title}</span>
        {meta && <span className="ml-auto shrink-0 text-sol-text-dim">{meta}</span>}
      </div>
      {children}
    </Panel>
  );
}

// ---------------------------------------------------------------- the pictures

const VIGNETTES: Record<string, (t: Tone) => ReactNode> = {
  stable: (t) => (
    <Panel className="w-full max-w-[250px] p-2.5">
      <div className="mb-1.5 text-sol-text-dim">session start</div>
      <div className={`rounded border px-2 py-1.5 ${t.wash}`}>
        <div className={`mb-1 ${t.text}`}>Recent work</div>
        {["Billing retries: shipped", "Auth refactor: blocked on review", "Flaky e2e: root cause found"].map((l) => (
          <div key={l} className="truncate text-sol-text">· {l}</div>
        ))}
      </div>
    </Panel>
  ),

  memory: (t) => (
    <div className="w-full max-w-[260px] space-y-1.5">
      <Panel className="flex items-center gap-1.5 px-2 py-1.5 text-sol-text">
        <span className={t.text}>$</span> cast search &quot;retry backoff&quot;
      </Panel>
      {[
        ["3 days ago", "chose exponential, capped at 30s"],
        ["last week", "fixed thundering herd on reconnect"],
      ].map(([when, what]) => (
        <Panel key={when} className="px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Dot className={t.dot} />
            <span className="text-sol-text">{what}</span>
          </div>
          <div className="mt-0.5 pl-3 text-sol-text-dim">session · {when}</div>
        </Panel>
      ))}
    </div>
  ),

  state: (t) => (
    <div className="w-full max-w-[250px] space-y-1">
      <SessionRow title="Payment webhook rewrite" dot="bg-sol-yellow">
        <div className="mt-1 truncate rounded bg-sol-yellow/10 px-1.5 py-0.5 text-sol-yellow">Blocked: need the prod signing key</div>
      </SessionRow>
      <SessionRow title="Search ranking tweaks" dot={t.dot} meta="working" />
      <SessionRow title="Docs typo sweep" dot="bg-sol-green" meta="done" />
    </div>
  ),

  messaging: (t) => (
    <div className="flex w-full max-w-[270px] items-center gap-2">
      <SessionRow title="Migration" dot="bg-sol-green" />
      <div className={`flex shrink-0 flex-col items-center ${t.text}`}>
        <ArrowRight className="h-4 w-4" />
      </div>
      <Panel className="min-w-0 flex-1 px-2 py-1.5">
        <div className="text-sol-text-dim">API session</div>
        <div className={`mt-1 rounded border px-1.5 py-1 text-sol-text ${t.wash}`}>
          Schema landed. Columns renamed; update the serializer.
        </div>
      </Panel>
    </div>
  ),

  forks: (t) => (
    <div className="w-full max-w-[240px]">
      <SessionRow title="Fix flaky checkout test" dot={t.dot} />
      <div className="ml-3 mt-1 space-y-1 border-l border-sol-border pl-2.5">
        {[
          ["Try: retry the payment mock", "bg-sol-green", "done"],
          ["Try: freeze the clock", "bg-sol-green", "done"],
          ["Review both fixes", t.dot, "working"],
        ].map(([title, dot, meta]) => (
          <SessionRow key={title} title={title} dot={dot} meta={meta} />
        ))}
      </div>
    </div>
  ),

  decide: (t) => (
    <Panel className="w-full max-w-[250px] p-2.5">
      <div className="text-[11px] text-sol-text">Cache sessions in Redis or in memory?</div>
      <Bar w="85%" className="mt-1.5" />
      <div className="mt-2 space-y-1">
        <div className={`flex items-center gap-1.5 rounded border px-1.5 py-1 ${t.wash}`}>
          <span className={`rounded border border-current px-1 ${t.text}`}>1</span>
          <span className="text-sol-text">Redis: survives deploys</span>
        </div>
        <div className="flex items-center gap-1.5 rounded border border-sol-border/70 px-1.5 py-1">
          <span className="rounded border border-sol-border px-1">2</span>
          <span>In memory: no new service</span>
        </div>
      </div>
    </Panel>
  ),

  chat: (t) => (
    <Panel className="w-full max-w-[250px] p-2.5">
      <div className="mb-1.5 text-sol-text-dim"># releases</div>
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <span className="mt-px h-3.5 w-3.5 shrink-0 rounded-full bg-sol-text-dim/30" />
          <div>
            <div className="text-sol-text">Dana</div>
            <div>is the 2.4 build out yet?</div>
          </div>
        </div>
        <div className="flex gap-1.5">
          <span className={`mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ${t.tile}`}>✦</span>
          <div>
            <div className="text-sol-text">
              agent <span className="text-sol-text-dim">· agent-written</span>
            </div>
            <div className="text-sol-text">Shipped 2.4.0 at 14:02. Changelog in the thread.</div>
          </div>
        </div>
      </div>
    </Panel>
  ),

  calls: (t) => (
    <Panel className="w-full max-w-[260px] p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-sol-text-dim">
        <Play className="h-3 w-3" /> Planning huddle · 24 min
      </div>
      {[
        ["Sam", "Let's drop the legacy export."],
        ["Priya", "I'll take the migration path."],
      ].map(([who, said], i) => (
        <div key={who} className={`flex gap-2 rounded px-1 py-0.5 ${i === 1 ? t.wash + " border" : ""}`}>
          <span className={`w-9 shrink-0 ${i === 1 ? t.text : "text-sol-text-dim"}`}>{who}</span>
          <span className="text-sol-text">{said}</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center gap-1 text-sol-text-dim">
        <Check className="h-3 w-3 text-sol-green" /> 2 action items filed as tasks
      </div>
    </Panel>
  ),

  tasks: (t) => (
    <Panel className="w-full max-w-[250px] p-2">
      {[
        ["Rewrite invoice export", "in progress", t.dot, 62],
        ["Add retry to webhook", "done", "bg-sol-green", 100],
        ["Backfill old invoices", "ready", "bg-sol-text-dim/50", 0],
      ].map(([title, status, dot, pct]) => (
        <div key={title as string} className="flex items-center gap-1.5 border-b border-sol-border/40 px-1 py-1.5 last:border-0">
          <Dot className={dot as string} />
          <span className="truncate text-sol-text">{title}</span>
          <span className="ml-auto shrink-0 text-sol-text-dim">{status}</span>
          <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-sol-text-dim/20">
            <span className={`block h-full ${t.fill}`} style={{ width: `${pct}%` }} />
          </span>
        </div>
      ))}
    </Panel>
  ),

  triggers: (t) => (
    <div className="w-full max-w-[250px] space-y-1">
      {[
        ["in 30m", "Check CI on main"],
        ["every 4h", "Sweep stale PRs"],
        ["on pr_comment", "Answer review threads"],
      ].map(([when, what], i) => (
        <Panel key={what} className="flex items-center gap-2 px-2 py-1.5">
          <span className={`w-[72px] shrink-0 rounded px-1 py-px text-center ${i === 0 ? t.tile : "bg-sol-bg-alt text-sol-text-dim"}`}>{when}</span>
          <span className="truncate text-sol-text">{what}</span>
        </Panel>
      ))}
    </div>
  ),

  workflows: (t) => {
    const node = (label: string, cls: string) => (
      <span className={`rounded border px-1.5 py-1 text-center ${cls}`}>{label}</span>
    );
    return (
      <div className="flex items-center gap-1.5 text-sol-text">
        {node("Implement", "border-sol-green/40 bg-sol-green/10")}
        <ArrowRight className="h-3 w-3 text-sol-text-dim" />
        {node("Typecheck", "border-sol-green/40 bg-sol-green/10")}
        <ArrowRight className="h-3 w-3 text-sol-text-dim" />
        <span className={`rounded border px-1.5 py-1 text-center ${t.wash}`}>
          <span className={t.text}>◆</span> Approve?
        </span>
      </div>
    );
  },

  orchestration: (t) => (
    <div className="w-full max-w-[260px] space-y-1.5">
      {[
        ["Wave 1", ["Schema", "API"], "bg-sol-green"],
        ["Wave 2", ["UI", "Docs", "Tests"], t.dot],
      ].map(([wave, items, dot]) => (
        <div key={wave as string} className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-sol-text-dim">{wave}</span>
          <div className="flex flex-wrap gap-1">
            {(items as string[]).map((it) => (
              <Panel key={it} className="flex items-center gap-1 px-1.5 py-1 text-sol-text">
                <Dot className={dot as string} /> {it}
              </Panel>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-sol-text-dim">Critic</span>
        <Panel className="px-1.5 py-1 text-sol-text-dim">final sweep</Panel>
      </div>
    </div>
  ),

  skills: (t) => (
    <Panel className="w-full max-w-[230px] overflow-hidden">
      <div className="border-b border-sol-border/60 px-2 py-1.5 text-sol-text">
        /cast-<span className="animate-pulse">▍</span>
      </div>
      {[
        ["/cast-pickup", "start where the team left off"],
        ["/cast-handoff", "package work for the next session"],
        ["/cast-ship", "see a PR through to merge"],
      ].map(([cmd, what], i) => (
        <div key={cmd} className={`truncate px-2 py-1 ${i === 0 ? t.wash + " border-y" : ""}`}>
          <span className={i === 0 ? t.text : "text-sol-text"}>{cmd}</span>
          <span className="ml-1.5 text-sol-text-dim">{what}</span>
        </div>
      ))}
    </Panel>
  ),

  pr: (t) => (
    <Panel className="w-full max-w-[250px] p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-sol-text">
        <span className="text-sol-green">●</span> #482 Safer invoice migration
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <span className="rounded bg-sol-green/10 px-1 py-px text-sol-green">✓ checks</span>
        <span className="rounded bg-sol-yellow/10 px-1 py-px text-sol-yellow">2 threads</span>
        <span className={`rounded px-1 py-px ${t.tile}`}>owned by a session</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 border-t border-sol-border/50 pt-1.5">
        <Check className="h-3 w-3 text-sol-green" />
        <span>thread resolved: &ldquo;guard the null case&rdquo;</span>
      </div>
    </Panel>
  ),

  visual: (t) => (
    <Panel className="w-full max-w-[250px] p-2.5">
      <div className="mb-2 text-sol-text">Latency by option (p95)</div>
      <div className="flex h-[58px] items-end gap-2">
        {[
          ["Redis", 34, false],
          ["Memory", 18, true],
          ["None", 92, false],
        ].map(([label, h, best]) => (
          <div key={label as string} className="flex flex-1 flex-col items-center gap-1">
            <span className={`w-full rounded-t ${best ? t.fill : "bg-sol-text-dim/30"}`} style={{ height: `${(h as number) * 0.55}px` }} />
            <span className={best ? t.text : "text-sol-text-dim"}>{label}</span>
          </div>
        ))}
      </div>
    </Panel>
  ),

  publish: (t) => (
    <Panel className="w-full max-w-[250px] overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-sol-border/60 px-2 py-1">
        <Lock className="h-2.5 w-2.5 text-sol-text-dim" />
        <span className="truncate">codecast.sh/a/<span className={t.text}>weekly-errors</span></span>
        <span className="ml-auto text-sol-text-dim">v3</span>
      </div>
      <div className="flex gap-2 p-2.5">
        <div className="flex-1 space-y-1">
          <div className="text-[11px] text-sol-text">Error trends</div>
          <Bar w="95%" />
          <Bar w="80%" />
          <Bar w="60%" />
        </div>
        <div className="flex h-10 w-16 items-end gap-0.5">
          {[30, 55, 40, 80, 45, 25].map((h, i) => (
            <span key={i} className={`flex-1 rounded-t ${i === 3 ? t.fill : "bg-sol-text-dim/30"}`} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </Panel>
  ),

  mods: (t) => (
    <Panel className="flex w-full max-w-[250px] overflow-hidden">
      <div className="w-16 shrink-0 space-y-1.5 whitespace-nowrap border-r border-sol-border/60 p-2">
        <Bar w="100%" />
        <Bar w="80%" />
        <div className={`rounded px-1 py-0.5 ${t.tile}`}>My PRs</div>
        <Bar w="70%" />
      </div>
      <div className="min-w-0 flex-1 space-y-1 p-2">
        <div className="text-sol-text">My PRs</div>
        {[["#482", "bg-sol-green"], ["#479", "bg-sol-yellow"], ["#471", "bg-sol-green"]].map(([n, dot]) => (
          <div key={n} className="flex items-center gap-1.5">
            <Dot className={dot} />
            <span className="text-sol-text">{n}</span>
            <Bar w="60%" />
          </div>
        ))}
      </div>
    </Panel>
  ),

  browser: (t) => (
    <Panel className="w-full max-w-[250px] overflow-hidden">
      <div className="flex items-center gap-1 border-b border-sol-border/60 bg-sol-bg-alt/60 px-1.5 pt-1">
        <span className="rounded-t border border-b-0 border-sol-border/60 bg-sol-bg px-1.5 py-0.5 text-sol-text">Your tab</span>
        <span className={`rounded-t px-1.5 py-0.5 ${t.tile}`}>Cast · settings</span>
      </div>
      <div className="flex gap-2 p-2">
        <div className="flex-1 space-y-1">
          <Bar w="70%" />
          <Bar w="90%" />
          <div className={`mt-1 inline-block rounded px-1.5 py-0.5 ${t.wash} border ${t.text}`}>Dark mode ✓</div>
        </div>
        <div className="w-16 shrink-0 rounded border border-sol-red/30 bg-sol-red/5 p-1 text-sol-red">0 errors</div>
      </div>
    </Panel>
  ),

  computer: (t) => (
    <Panel className="relative w-full max-w-[240px] overflow-hidden">
      <div className="flex gap-1 border-b border-sol-border/60 px-2 py-1.5">
        <Dot className="bg-sol-red/50" />
        <Dot className="bg-sol-yellow/50" />
        <Dot className="bg-sol-green/50" />
        <span className="ml-1 text-sol-text-dim">Preview</span>
      </div>
      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1.5"><span className="text-sol-text-dim">[12]</span> button &ldquo;Export&rdquo;</div>
        <div className={`flex items-center gap-1.5 rounded border px-1 ${t.wash}`}>
          <span className={t.text}>[13]</span> <span className="text-sol-text">button &ldquo;Share&rdquo;</span>
        </div>
        <div className="flex items-center gap-1.5"><span className="text-sol-text-dim">[14]</span> text &ldquo;Page 1 of 8&rdquo;</div>
      </div>
      <svg className={`absolute bottom-3 right-6 h-4 w-4 ${t.text}`} viewBox="0 0 16 16" fill="currentColor">
        <path d="M2 1l11 6-5 1.5L6 14z" />
      </svg>
    </Panel>
  ),

  sim: (t) => (
    <div className="flex items-center gap-3">
      <div className="h-[104px] w-[54px] rounded-[10px] border-2 border-sol-text-dim/40 bg-sol-bg p-1">
        <div className="flex h-full flex-col gap-1 rounded-[6px] bg-sol-bg-alt/70 p-1">
          <Bar w="70%" />
          <Bar w="90%" />
          <span className={`mt-auto block rounded py-0.5 text-center text-[8px] ${t.tile}`}>Sign up</span>
        </div>
      </div>
      <div className="space-y-1">
        <div><span className={t.text}>$</span> cast sim tap --label &quot;Sign up&quot;</div>
        <div className="text-sol-text-dim">✓ screenshot in the thread</div>
      </div>
    </div>
  ),

  check: (t) => (
    <Term
      t={t}
      lines={[
        ["cast check web", "✓ web: 0 errors (pass 2s old)"],
        ["cast check-status", "1 watcher · 9 sessions sharing it"],
      ]}
    />
  ),

  limits: (t) => (
    <Panel className="w-full max-w-[240px] p-2.5">
      <div className="flex items-center justify-between text-sol-text">
        <span>5-hour window</span>
        <span className="text-sol-text-dim">resets 14:00</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sol-text-dim/20">
        <span className="block h-full w-full bg-sol-yellow/70" />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Circle className="h-2.5 w-2.5 text-sol-yellow" fill="currentColor" />
        <span>parked</span>
        <ArrowRight className="h-3 w-3 text-sol-text-dim" />
        <span className={t.text}>resumed on another account</span>
      </div>
    </Panel>
  ),
};

/** For tests: which features have a picture. */
export const VIGNETTE_SLUGS = Object.keys(VIGNETTES);

