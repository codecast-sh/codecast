"use client";

import { useState, type ReactNode } from "react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { SOL } from "../../blog/blogChrome";
import { ChromeWindow, HUMAN_TABS } from "./ChromeWindow";
import { CheckoutPage } from "./Checkout";
import { AgentCursor, C, CAST_RED, ChromeTab, DIM, EYE_ICON, Favicon, GLOBE_ICON, GroupChip, HUMAN_CYAN, INK, MUTED, OPEN_TAB_ICON, REF_BLUE, RowPill, Scaled, Section, TermShell } from "./kit";

/* ------------------------------------------------------------------ */
/* 1. Your Chrome, one tab group                                       */
/* ------------------------------------------------------------------ */

const AGENT_TABS = [
  { title: "Checkout · Acme", agent: "claude", agentColor: SOL.blue, task: "Verify the order fix on staging", fav: <Favicon color="#1d2733" glyph="a" /> },
  { title: "Billing settings", agent: "codex", agentColor: SOL.green, task: "Reproduce the invoice bug", fav: <Favicon color="#635bff" glyph="S" /> },
  { title: "Sign in · Linear", agent: "claude", agentColor: SOL.blue, task: "Triage this week's issues", fav: <Favicon color="#5e6ad2" glyph="L" /> },
];

export function TabGroupSection() {
  return (
    <Section
      id="your-chrome"
      label="Cast"
      title="Your Chrome, your logins. Agents get one tab group."
      lede={<>The codecast extension lets agent sessions open tabs in the Chrome you already use. Every agent tab opens in the background, inside a red <strong style={{ color: CAST_RED }}>Cast</strong> group. Your own tabs, windows and focus stay where you left them.</>}
    >
      <CastTabStrip />

      <div className="mt-12 grid md:grid-cols-2 gap-x-14 gap-y-9">
        <Fact title="No clone, no copied cookies">
          The agent uses the profile you are signed into. A dashboard behind SSO, a staging site, an admin panel: if your Chrome can open it, the agent can read it. Nothing syncs your profile anywhere.
        </Fact>
        <Fact title="Background tabs, always">
          <C>cast browser open</C> creates the tab directly at the URL, in the background. Your screen only changes when an agent runs <C>show</C>, which it does when you asked to see the page or must act in it.
        </Fact>
        <Fact title="One tab per session, and it knows which">
          <C>open</C> reuses the session&apos;s tab. <C>tabs</C> lists this session&apos;s tabs and <C>tabs --all</C> every agent&apos;s. Several agents can share one Chrome without stepping on each other.
        </Fact>
        <Fact title="You can always see who is driving">
          A driven page wears a thin red border (hidden in screenshots), the toolbar icon shows a <span className="font-mono text-[12px] font-bold px-1 rounded text-white" style={{ backgroundColor: CAST_RED }}>CAST</span> badge, and Chrome shows its own debugging banner while a tab is attached. <C>stop</C> closes the session&apos;s tab when the work is done.
        </Fact>
      </div>
    </Section>
  );
}

/** Chrome's tab strip: the person's tabs, then the red Cast group holding one tab per agent session. */
export function CastTabStrip() {
  return (
    <div className="rounded-2xl p-4 sm:p-7" style={{ background: "linear-gradient(180deg, #e9ecf0, #dfe3e8)" }}>
      {/* The strip, drawn large. */}
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <div className="flex items-end sm:min-w-[760px]">
          {HUMAN_TABS.map((t, i) => (
            <span key={t.title} className={i === 1 ? "flex min-w-0" : "hidden sm:flex min-w-0"}>
              <ChromeTab title={t.title} fav={t.fav} active={i === 1} width={170} />
            </span>
          ))}
          <span className="self-center mx-1.5"><GroupChip label="Cast" /></span>
          {AGENT_TABS.map((t) => (
            <ChromeTab key={t.title} title={t.title} fav={t.fav} groupColor={CAST_RED} badge width={170} />
          ))}
        </div>
      </div>
      {/* Who is in each tab. */}
      <div className="mt-5 grid sm:grid-cols-[1fr_1.55fr] gap-4 sm:gap-6 font-mono text-[12px]">
        <div className="rounded-lg bg-white/70 px-4 py-3">
          <div className="text-[11px] mb-2" style={{ color: MUTED }}>yours</div>
          <div style={{ color: INK }}>Mail, a doc, a pull request. Never touched, never closed, never brought forward by an agent.</div>
        </div>
        <div className="rounded-lg bg-white/70 px-4 py-3" style={{ boxShadow: `inset 3px 0 0 ${CAST_RED}` }}>
          <div className="text-[11px] mb-2" style={{ color: CAST_RED }}>the Cast group · one tab per session</div>
          <div className="space-y-1.5">
            {AGENT_TABS.map((t) => (
              <div key={t.title} className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 font-medium" style={{ color: t.agentColor }}>{t.agent}</span>
                <span className="truncate" style={{ color: INK }}>{t.task}</span>
                <span className="ml-auto shrink-0 hidden sm:inline" style={{ color: DIM }}>{t.title}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="font-mono font-bold text-[16px] tracking-tight" style={{ color: INK }}>{title}</h3>
      <p className="mt-2 text-[15.5px] leading-7" style={{ color: SOL.base01 }}>{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Snapshot, then act on a ref                                       */
/* ------------------------------------------------------------------ */

const SNAP_ROWS: { n: number; role: string; name: string }[] = [
  { n: 3, role: "textbox", name: "Email" },
  { n: 4, role: "textbox", name: "Card number" },
  { n: 5, role: "combobox", name: "Shipping" },
  { n: 6, role: "checkbox", name: "Save this card" },
  { n: 7, role: "button", name: "Place order" },
];

export function RefsSection() {
  const [hover, setHover] = useState<number | null>(7);
  return (
    <Section
      id="refs"
      label="#e7"
      color={REF_BLUE}
      tone="sand"
      title="Read the page as a list of things to press, then press one."
      lede={<>From here down is the agent&apos;s side: commands it runs, so you never type them. A snapshot is the page&apos;s accessibility tree, cut down to what an agent can act on. Each element gets a ref like <C>#e7</C>, and every acting verb takes one. No pixel guessing, no brittle selectors. Hover a row to see what it points at.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 items-stretch">
        <TermShell label="cast browser snapshot -i -s main" bodyClassName="p-0">
          <div className="py-3">
            {SNAP_ROWS.map((r) => (
              <button
                key={r.n}
                type="button"
                onMouseEnter={() => setHover(r.n)}
                onFocus={() => setHover(r.n)}
                onClick={() => setHover(r.n)}
                className="w-full text-left px-4 py-1.5 font-mono text-[12.5px] transition-colors flex gap-2"
                style={{ backgroundColor: hover === r.n ? "rgba(38,139,210,.16)" : "transparent" }}
              >
                <span style={{ color: SOL.base01 }}>- {r.role}</span>
                <span style={{ color: SOL.base2 }}>&quot;{r.name}&quot;</span>
                <span style={{ color: REF_BLUE }}>[ref=e{r.n}]</span>
              </button>
            ))}
            <div className="mt-3 px-4 pt-3 font-mono text-[12.5px] space-y-1" style={{ borderTop: "1px solid #094959" }}>
              <div><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser click </span><span style={{ color: REF_BLUE }}>#e{hover ?? 7}</span></div>
              <div><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser find &quot;Place order&quot;</span> <span style={{ color: SOL.base01 }}># then a bare</span> <span style={{ color: SOL.base1 }}>click</span></div>
            </div>
          </div>
        </TermShell>
        <div className="relative min-h-[340px] rounded-xl overflow-hidden" style={{ boxShadow: `0 0 0 1.5px ${CAST_RED}, 0 24px 50px -24px rgba(0,43,54,.45)` }}>
          <CheckoutPage phase={2} highlight={hover} />
        </div>
      </div>

      <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-px rounded-xl overflow-hidden" style={{ backgroundColor: "rgba(147,161,161,.35)" }}>
        <Tip cmd="snapshot -i -s <sel>" color={REF_BLUE}>Interactive elements only, in one region. Big apps stay cheap to read.</Tip>
        <Tip cmd='find "Delete (3rd)"' color={REF_BLUE}>Names are matched on visible text. Namesakes are numbered, and visible elements rank first.</Tip>
        <Tip cmd="diff snapshot" color={REF_BLUE}>Only what changed since the last snapshot, so a step&apos;s effect is one short read.</Tip>
        <Tip cmd="read" color={REF_BLUE}>The page as clean text, for &quot;what does this page say&quot;. <C>get text &lt;sel&gt;</C> reads one element.</Tip>
      </div>
      <p className="mt-6 text-[15px] leading-7 max-w-3xl" style={{ color: SOL.base01 }}>
        Refs survive a re-render. Each snapshot records every ref&apos;s role, name and position among its namesakes, so when the page refreshes and <C>#e5</C> goes stale, cast finds the element at the same position again, the third &quot;Delete&quot; and not the first.
      </p>
    </Section>
  );
}

function Tip({ cmd, color, children }: { cmd: string; color: string; children: ReactNode }) {
  return (
    <div className="px-5 py-5" style={{ backgroundColor: "#fbf6e6" }}>
      <div className="font-mono text-[12.5px] font-semibold" style={{ color }}>{cmd}</div>
      <p className="mt-2 text-[14px] leading-6" style={{ color: SOL.base01 }}>{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Batch with do                                                    */
/* ------------------------------------------------------------------ */

const DO_STEPS = ["open", "find", "click", "wait", "shot"];

export function DoSection() {
  // Drawn to scale: 2 s of CLI start per process, 85 ms of browser work per step.
  const total = 5 * 2000 + 5 * 85;
  const pct = (ms: number) => `${(ms / total) * 100}%`;
  return (
    <Section
      id="do"
      label="do"
      color={SOL.green}
      title="Five steps, one process."
      lede={<>Every <C>cast</C> command spends one to three seconds starting up for about 85 ms of work in the browser. <C>cast browser do</C> runs a whole flow in one process, so an agent that can see three steps ahead pays for one start, not three.</>}
    >
      <div className="rounded-2xl p-5 sm:p-7" style={{ backgroundColor: "#fffaf0", border: "1px solid #eee3c6" }}>
        <TimelineRow label="five commands">
          {DO_STEPS.map((s) => (
            <span key={s} className="contents">
              <Seg w={pct(2000)} kind="start" />
              <Seg w={pct(85)} kind="work" title={s} />
            </span>
          ))}
        </TimelineRow>
        <TimelineRow label="one do">
          <Seg w={pct(2000)} kind="start" />
          {DO_STEPS.map((s) => <Seg key={s} w={pct(85)} kind="work" title={s} />)}
        </TimelineRow>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[12px] font-mono" style={{ color: MUTED }}>
          <span className="flex items-center gap-2"><span className="h-2.5 w-5 rounded-sm" style={{ backgroundColor: "rgba(147,161,161,.35)" }} /> CLI start, about 2 s</span>
          <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: SOL.green }} /> browser work, about 85 ms</span>
          <span style={{ color: DIM }}>drawn to scale</span>
        </div>
      </div>

      <div className="mt-10 grid lg:grid-cols-2 gap-6 items-start [&>*]:min-w-0">
        <TermShell label="one flow, one step per line" bodyClassName="px-4 py-3.5">
          <div><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser do - &lt;&lt;&apos;EOF&apos;</span></div>
          <div>open https://app.acme.dev/settings</div>
          <div>find &quot;Sign in&quot;</div>
          <div>click</div>
          <div>wait --text &quot;Billing&quot;</div>
          <div>shot</div>
          <div style={{ color: SOL.base01 }}>EOF</div>
        </TermShell>
        <ul className="space-y-5 text-[15.5px] leading-7" style={{ color: SOL.base01 }}>
          <li><Strong>A step without a ref</Strong> acts on whatever the last <C>find</C> matched, so a flow reads like instructions to a person.</li>
          <li><Strong>It stops at the first failing step</Strong> and reports what ran and what never did. <C>--keep-going</C> carries on past it.</li>
          <li><Strong>Each step&apos;s result shows in the conversation</Strong> as one row, with one screenshot at the end instead of a frame per step.</li>
          <li><Strong>Waits are for the state you mean.</Strong> <C>wait --text</C>, <C>--url</C>, <C>--load</C> or <C>--fn</C>, not a fixed sleep.</li>
        </ul>
      </div>
    </Section>
  );
}

function TimelineRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] sm:grid-cols-[120px_1fr] items-center gap-3 py-2">
      <span className="font-mono text-[12px] sm:text-[13px]" style={{ color: INK }}>{label}</span>
      <div className="flex h-7 items-stretch gap-[2px]">{children}</div>
    </div>
  );
}

function Seg({ w, kind, title }: { w: string; kind: "start" | "work"; title?: string }) {
  return (
    <span
      className="rounded-[3px] shrink-0 min-w-[3px]"
      title={title}
      style={{ width: w, backgroundColor: kind === "start" ? "rgba(147,161,161,.35)" : SOL.green }}
    />
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold" style={{ color: INK }}>{children}</strong>;
}

/* ------------------------------------------------------------------ */
/* 4. Evidence lands in the thread                                     */
/* ------------------------------------------------------------------ */

export function EvidenceSection() {
  return (
    <Section
      id="evidence"
      label="in the thread"
      color={SOL.yellow}
      title="What the agent saw ends up in the conversation."
      lede="You should not have to ask an agent for proof. Screenshots render under the command that took them, and a failing step brings its own context."
    >
      <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-8 items-start">
        {/* The conversation */}
        <div className="rounded-2xl overflow-hidden font-mono text-left shadow-[0_30px_60px_-30px_rgba(0,43,54,.45)]" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8" }}>
          <div className="flex items-center gap-2 px-4 py-2.5 text-[12px]" style={{ borderBottom: "1px solid rgba(147,161,161,.18)" }}>
            <span className="font-medium" style={{ color: INK }}>Mobile checkout looks broken</span>
            <span className="ml-auto text-[11px]" style={{ color: SOL.blue }}>claude</span>
          </div>
          <div className="p-4 space-y-5">
            <ThreadRow cmd="browser shot" summary="--annotate">
              <Scaled w={720} h={430}><CheckoutPage phase={2} annotate thumb /></Scaled>
              <div className="mt-1.5 text-[10.5px]" style={{ color: MUTED }}>each [N] label is snapshot ref #eN, with a legend</div>
            </ThreadRow>
            <ThreadRow cmd="browser shot" summary="desktop, then after viewport mobile">
              <div className="flex gap-2 items-start">
                <MiniShot w={760} h={430} className="flex-[2.1]" />
                <MiniShot w={375} h={640} className="flex-[0.6]" narrow />
              </div>
            </ThreadRow>
            <ThreadRow cmd="browser wait" summary='--text "Order confirmed"' failed>
              <div className="rounded-md px-3 py-2.5 text-[11px] leading-[1.65]" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
                <div style={{ color: "#ff6f61" }}>✗ &quot;Order confirmed&quot; never appeared</div>
                <div style={{ color: SOL.base01 }}>── failure context ──────────</div>
                <div>console errors (newest first):</div>
                <div className="truncate">  <span style={{ color: SOL.base01 }}>+6.1s</span> <span style={{ color: "#ff6f61" }}>ERR</span> TypeError: Cannot read properties of undefined</div>
                <div>failed requests (newest first):</div>
                <div className="truncate">  <span style={{ color: "#ff6f61" }}>500</span> POST  812ms https://staging.acme.dev/api/orders</div>
              </div>
            </ThreadRow>
          </div>
        </div>

        {/* What each piece is */}
        <div className="space-y-7">
          <Evidence title="A screenshot, inline" agent="shot">
            Renders under the step that took it, in the thread. It can be one element, the whole scroll height, or a link the agent uploads so you can paste it anywhere.
          </Evidence>
          <Evidence title="Numbers drawn on the picture" agent="shot --annotate">
            Every button and field on the image gets a number, so you and the agent can talk about &quot;7&quot; and mean the same button.
          </Evidence>
          <Evidence title="The same page at another size" agent="viewport mobile">
            The agent can show you the page as a phone, a tablet or an exact size sees it, then put the tab back.
          </Evidence>
          <Evidence title="Errors arrive with the failure">
            A step that fails comes back with the page&apos;s console errors and failed requests, newest first, and a picture of what the screen showed. You see why without asking.
          </Evidence>
          <Evidence title="Each row has its controls" >
            <b style={{ color: INK }}>open tab</b> brings the agent&apos;s tab forward in your Chrome. <b style={{ color: INK }}>watch live</b> streams it into a pane beside the thread.
          </Evidence>
        </div>
      </div>
    </Section>
  );
}

function ThreadRow({ cmd, summary, failed = false, children }: { cmd: string; summary: string; failed?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] mb-2">
        <span className="flex items-center gap-1" style={{ color: failed ? CAST_RED : SOL.blue }}>{GLOBE_ICON} {cmd}</span>
        <span className="truncate" style={{ color: MUTED }}>{summary}</span>
        <span className="ml-auto hidden sm:flex gap-1">
          <RowPill>{OPEN_TAB_ICON} open tab</RowPill>
          <RowPill>{EYE_ICON} watch live</RowPill>
        </span>
      </div>
      {children}
    </div>
  );
}

/** A downscaled render of the checkout at a given viewport. */
function MiniShot({ w, h, className = "", narrow = false }: { w: number; h: number; className?: string; narrow?: boolean }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <Scaled w={w} h={h}><CheckoutPage phase={1} thumb={!narrow} narrow={narrow} /></Scaled>
      <div className="mt-1 text-[10px]" style={{ color: MUTED }}>{narrow ? "mobile" : "desktop"}</div>
    </div>
  );
}

/** One thing the person sees in the thread; `agent` names the command behind it, as a quiet aside. */
function Evidence({ title, agent, children }: { title: string; agent?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[3px_1fr] gap-4">
      <span className="rounded-full" style={{ backgroundColor: SOL.yellow }} />
      <div>
        <h3 className="font-mono font-bold text-[15.5px]" style={{ color: INK }}>{title}</h3>
        <p className="mt-1.5 text-[15px] leading-7" style={{ color: SOL.base01 }}>{children}</p>
        {agent && <div className="mt-1 font-mono text-[11.5px]" style={{ color: DIM }}>the agent runs <span style={{ color: MUTED }}>{agent}</span></div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4b. What agents use it for                                          */
/* ------------------------------------------------------------------ */

type Scenario = { key: string; title: string; ask: string; lines: ReactNode[]; lands: ReactNode };

const $ = (rest: ReactNode) => <><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser</span> {rest}</>;
const note = (t: string) => <span style={{ color: SOL.base01 }}># {t}</span>;
const ref = (t: string) => <span style={{ color: REF_BLUE }}>{t}</span>;

const SCENARIOS: Scenario[] = [
  {
    key: "verify",
    title: "Check its own UI change",
    ask: "\u201cThe save button on settings should show a toast now. Make sure it does.\u201d",
    lines: [
      $(<>open http://localhost:3000/settings</>),
      $(<>snapshot -i -s main</>),
      $(<>do &quot;click {ref("#e12")}&quot; &quot;wait --text Saved&quot; shot</>),
    ],
    lands: <>A screenshot of the toast under the agent&apos;s browser row, or, if &quot;Saved&quot; never shows, the console errors and failed requests that explain why.</>,
  },
  {
    key: "signin",
    title: "Read what sits behind your sign-in",
    ask: "\u201cWhat does the admin panel say about this customer\u2019s plan?\u201d",
    lines: [
      $(<>open https://admin.acme.dev/customers/4821</>),
      $(<>get text &quot;[role=main] section.plan&quot;</>),
      <>{note("no token, no API client: your Chrome is already signed in")}</>,
    ],
    lands: <>The text it read, quoted in the agent&apos;s answer. The visit is recorded on the machine&apos;s audit trail as one origin.</>,
  },
  {
    key: "repro",
    title: "Reproduce a bug report",
    ask: "\u201cUsers say export hangs on the reports page. Find out why.\u201d",
    lines: [
      $(<>open https://staging.acme.dev/reports</>),
      $(<>do &quot;find Export&quot; click &quot;wait --text Ready&quot;</>),
      $(<>network requests --status 5xx</>),
      $(<>errors</>),
    ],
    lands: <>The failing step&apos;s capture, then the 5xx requests and uncaught errors, each as its own row the agent reasons from.</>,
  },
  {
    key: "mobile",
    title: "Look at it on a phone",
    ask: "\u201cDoes the new pricing table work on mobile?\u201d",
    lines: [
      $(<>open https://acme.dev/pricing</>),
      $(<>viewport mobile</>),
      $(<>shot --full</>),
      $(<>viewport --reset</>),
    ],
    lands: <>A full-height screenshot at phone width, inline, so you see the same frame the agent judged.</>,
  },
];

export function ScenariosSection() {
  const [pick, setPick] = useState(0);
  const sc = SCENARIOS[pick];
  return (
    <Section
      id="uses"
      label="jobs"
      color={SOL.cyan}
      tone="sand"
      title="What agents reach for it to do."
      lede="Most of it is the work a person does in a browser after writing code: look at the result, read something behind a login, chase a bug report, check a phone layout."
    >
      <div className="grid lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] gap-5 lg:gap-8 items-start">
        <div className="flex lg:flex-col gap-2 overflow-x-auto -mx-5 px-5 lg:mx-0 lg:px-0 pb-1 lg:pb-0" role="tablist">
          {SCENARIOS.map((x, i) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={pick === i}
              onClick={() => setPick(i)}
              className="shrink-0 text-left rounded-xl px-4 py-3 transition-all"
              style={pick === i
                ? { backgroundColor: "#fffaf0", boxShadow: `inset 3px 0 0 ${SOL.cyan}, 0 10px 24px -16px rgba(0,43,54,.4)`, color: INK }
                : { backgroundColor: "transparent", color: SOL.base01 }}
            >
              <span className="font-mono font-semibold text-[14px] whitespace-nowrap lg:whitespace-normal">{x.title}</span>
            </button>
          ))}
        </div>
        <div key={sc.key} className="bx-fade min-w-0">
          <p className="font-sans text-[17px] leading-7" style={{ color: INK }}>{sc.ask}</p>
          <div className="mt-4 flex gap-3 items-start text-[15px] leading-7" style={{ color: SOL.base01 }}>
            <span className="mt-[9px] h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: SOL.yellow }} />
            <p><strong className="font-semibold" style={{ color: INK }}>In the conversation:</strong> {sc.lands}</p>
          </div>
          <TermShell label="what the agent ran" className="mt-5 text-[12px]" bodyClassName="px-4 py-3 space-y-1">
            {sc.lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-words">{l}</div>)}
          </TermShell>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 5. When it needs you: watch, the wheel, show                        */
/* ------------------------------------------------------------------ */

export function WheelSection() {
  const [wheel, setWheel] = useState(false);
  return (
    <Section
      id="wheel"
      label="Take the wheel"
      color={HUMAN_CYAN}
      tone="sand"
      title="When a page needs a person, you step in without leaving the thread."
      lede="Some pages are yours to handle: a sign-in, a two-factor prompt, a camera permission. The agent says so and waits. You sign in, in the same tab, and it carries on."
    >
      <div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-8 items-start">
        <div className="rounded-2xl overflow-hidden font-mono" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8", boxShadow: "0 30px 60px -30px rgba(0,43,54,.45)" }}>
          {/* The dock's bar */}
          <div className="flex items-center gap-2 px-3 h-8 text-[11px]" style={{ borderBottom: "1px solid rgba(147,161,161,.2)", color: MUTED }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: wheel ? HUMAN_CYAN : SOL.green }} />
            <span className="truncate">id.linear.app/login</span>
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                aria-pressed={wheel}
                onClick={() => setWheel(!wheel)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10.5px] whitespace-nowrap transition-colors"
                style={wheel
                  ? { color: HUMAN_CYAN, borderColor: "rgba(42,161,152,.45)", backgroundColor: "rgba(42,161,152,.14)" }
                  : { color: SOL.base01, borderColor: "rgba(147,161,161,.5)", backgroundColor: "#fff" }}
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M14 4.1 12 6M5.1 8l-2.9-.8M6 12l-1.9 2M7.2 2.2 8 5.1M9.04 12.18a.5.5 0 0 1 .65-.65l9 3.5a.5.5 0 0 1-.06.95l-3.44.86a1 1 0 0 0-.73.73l-.86 3.44a.5.5 0 0 1-.95.06z" /></svg>
                {wheel ? "Hand back" : "Take the wheel"}
              </button>
            </span>
          </div>
          {/* The streamed frame */}
          <div className="relative h-[330px] sm:h-[360px]" style={{ backgroundColor: "#f6f7f9" }}>
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="w-full max-w-[300px] rounded-xl bg-white p-5 font-sans shadow-[0_1px_4px_rgba(0,0,0,.1)]">
                <div className="flex items-center gap-2"><Favicon color="#5e6ad2" glyph="L" /><span className="text-[14px] font-semibold text-[#1f2023]">Log in to Linear</span></div>
                <div className="mt-4 h-8 rounded-md border border-[#dfe1e4] px-2.5 flex items-center text-[12px] text-[#1f2023]">dana@acme.dev</div>
                <div className="mt-2 h-8 rounded-md border px-2.5 flex items-center text-[12px]" style={{ borderColor: wheel ? HUMAN_CYAN : "#dfe1e4", color: "#1f2023" }}>
                  {wheel ? <span className="tracking-[.2em]">••••••••<span className="bx-blink-human inline-block w-[1.5px] h-3 ml-0.5 align-middle" style={{ backgroundColor: HUMAN_CYAN }} /></span> : <span className="text-[#a0a4ab]">Password</span>}
                </div>
                <div className="mt-3 h-8 rounded-md flex items-center justify-center text-[12px] font-semibold text-white" style={{ backgroundColor: "#5e6ad2" }}>Continue</div>
              </div>
            </div>
            {!wheel && <AgentCursor x="62%" y="58%" />}
            {wheel ? (
              <span className="absolute bottom-2.5 left-1/2 -translate-x-1/2 max-w-[calc(100%-16px)] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] whitespace-nowrap" style={{ backgroundColor: "rgba(253,246,227,.95)", border: "1px solid rgba(42,161,152,.45)", color: MUTED }}>
                <span style={{ color: HUMAN_CYAN }}>You have the wheel.</span>
                <span className="truncate hidden sm:inline">The agent keeps its session; nothing you do here is sent to it.</span>
                <KeyCap size="xs">Esc</KeyCap>
                <span>hands back</span>
              </span>
            ) : (
              <span className="absolute bottom-2.5 left-3 right-3 sm:right-auto rounded-lg px-3 py-2 text-[11px] leading-snug font-sans" style={{ backgroundColor: "rgba(253,246,227,.96)", border: "1px solid #e4ddc8", color: SOL.base02 }}>
                <span className="font-mono text-[10.5px]" style={{ color: SOL.blue }}>claude</span> · Linear wants a sign-in. Please sign in here and I will continue in this tab.
              </span>
            )}
          </div>
        </div>
        <div className="space-y-7">
          <Step n="1" title="Watch it live">
            The <span className="font-mono text-[13px]" style={{ color: SOL.base01 }}>watch live</span> pill on any browser row streams the agent&apos;s tab into a pane beside the thread, with the agent&apos;s cursor drawn where each click lands. It only streams while you are looking.
          </Step>
          <Step n="2" title="Take the wheel">
            Your clicks and typing go to the page. The agent keeps its session and hears none of it. <KeyCap size="xs">Esc</KeyCap> hands the page back. Try the button on the left.
          </Step>
          <Step n="3" title="Or bring the tab forward">
            The <span className="font-mono text-[13px]" style={{ color: SOL.base01 }}>open tab</span> pill on the row raises the agent&apos;s tab to the front of your Chrome. An agent can do the same once, when you asked to see the page or must act in it, and never on a loop.
          </Step>
        </div>
      </div>
    </Section>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[30px_1fr] gap-3">
      <span className="h-[26px] w-[26px] rounded-full flex items-center justify-center font-mono text-[12px] font-bold" style={{ backgroundColor: "rgba(42,161,152,.15)", color: HUMAN_CYAN }}>{n}</span>
      <div>
        <h3 className="font-mono font-bold text-[15.5px]" style={{ color: INK }}>{title}</h3>
        <p className="mt-1.5 text-[15px] leading-7" style={{ color: SOL.base01 }}>{children}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. Safety: the bridge, the audit, the allowlist                     */
/* ------------------------------------------------------------------ */

export function SafetySection() {
  return (
    <Section
      id="safety"
      label="127.0.0.1"
      color={SOL.violet}
      tone="dark"
      title="It runs on your machine, and it keeps a record."
      lede="Giving an agent your signed-in browser is a real grant. So the connection never leaves the machine, every site an agent lands on is written down, and a project can limit where agents may go at all."
    >
      {/* The bridge diagram */}
      <div className="rounded-2xl p-5 sm:p-8" style={{ backgroundColor: SOL.base02, border: "1px solid #0b4a5a" }}>
        <div className="flex flex-col sm:flex-row items-stretch font-mono text-[12px]">
          <Node title="cast CLI" sub="your agent's shell" />
          <Wire label="websocket" />
          <Node title="bridge host" sub="127.0.0.1 only" accent />
          <Wire label="websocket" dir="left" note="extension connects out" />
          <Node title="Codecast extension" sub="in your Chrome profile" />
          <Wire label="chrome.debugger" />
          <Node title="the Cast tabs" sub="that sessions opened" red />
        </div>
        <p className="mt-6 text-[14px] leading-7 max-w-3xl font-sans" style={{ color: SOL.base1 }}>
          Pairing hands the extension a token once. After that, each side proves it holds the token with an HMAC over a fresh nonce, so the token itself never crosses the socket, and the extension runs nothing for a host that has not proved it. Setup never prints the token in agent output, because that output syncs off the machine.
        </p>
      </div>

      <div className="mt-10 grid lg:grid-cols-2 gap-6 items-start [&>*]:min-w-0">
        <div>
          <h3 className="font-mono font-bold text-[16px]" style={{ color: SOL.base2 }}>Every origin, recorded</h3>
          <p className="mt-2 mb-4 text-[15px] leading-7" style={{ color: SOL.base1 }}>
            The audit trail is always on. It keeps origins, never full URLs, because paths and query strings carry tokens. A refused navigation is on the trail too. The app has no view of it yet; read it in a terminal.
          </p>
          <TermShell label="cast browser audit" bodyClassName="px-4 py-3 text-[11.5px] overflow-x-auto">
            <div className="min-w-[560px] whitespace-pre">
              <div style={{ color: SOL.base01 }}>policy: ~/src/shop/.codecast/workspace.toml [browser] allow (2 entries)</div>
              {AUDIT.map(([t, mark, origin, how]) => (
                <div key={t}>{t} {mark ? <span style={{ color: "#ff6f61" }}>{mark}</span> : " "} {origin.padEnd(30)} <span style={{ color: SOL.base01 }}>{how}</span></div>
              ))}
              <div className="mt-1.5" style={{ color: SOL.base01 }}>3 visit(s), 1 blocked/off-policy</div>
            </div>
          </TermShell>
        </div>
        <div>
          <h3 className="font-mono font-bold text-[16px]" style={{ color: SOL.base2 }}>An allowlist, when you want one</h3>
          <p className="mt-2 mb-4 text-[15px] leading-7" style={{ color: SOL.base1 }}>
            Off by default. Turn it on per project, or per machine with <C dark>browser_allow</C> in <C dark>~/.codecast/config.json</C>. An empty list allows nothing. A click or redirect that lands off the list is flagged, never silently allowed.
          </p>
          <TermShell label=".codecast/workspace.toml" bodyClassName="px-4 py-3">
            <div style={{ color: SOL.base01 }}># agents in this repo may only browse these</div>
            <div style={{ color: SOL.yellow }}>[browser]</div>
            <div>allow = [<span style={{ color: SOL.cyan }}>&quot;*.acme.dev&quot;</span>, <span style={{ color: SOL.cyan }}>&quot;http://localhost&quot;</span>]</div>
          </TermShell>
        </div>
      </div>

      <div className="mt-10 grid sm:grid-cols-3 gap-6 text-[14.5px] leading-7" style={{ color: SOL.base1 }}>
        <p><span className="font-mono font-semibold" style={{ color: SOL.base2 }}>No silent fallback.</span> If the extension is missing or asleep, commands wait for it, then say what to fix. They never launch a different browser instead.</p>
        <p><span className="font-mono font-semibold" style={{ color: SOL.base2 }}>Dialogs cannot freeze a tab.</span> Alert, confirm and beforeunload dialogs are dismissed automatically; <C dark>dialogs</C> lists what the page tried to open.</p>
        <p><span className="font-mono font-semibold" style={{ color: SOL.base2 }}>Your tabs are off limits.</span> Agents act on tabs they opened. The extension never adopts a tab group you made.</p>
      </div>
    </Section>
  );
}

const AUDIT: [string, string, string, string][] = [
  ["10-04 14:02", "", "https://staging.acme.dev", "open · tab 1E226C3B"],
  ["10-04 14:03", "", "https://auth.acme.dev", "action · tab 1E226C3B"],
  ["10-04 14:05", "✗", "https://pastebin.com", "open · blocked"],
];

function Node({ title, sub, accent = false, red = false }: { title: string; sub: string; accent?: boolean; red?: boolean }) {
  const border = red ? CAST_RED : accent ? SOL.violet : "#2b5866";
  return (
    <div className="shrink-0 sm:w-[132px] rounded-xl px-3 py-3 text-center" style={{ border: `1.5px solid ${border}`, backgroundColor: accent ? "rgba(108,113,196,.12)" : red ? "rgba(220,50,47,.1)" : SOL.base03 }}>
      <div className="font-semibold" style={{ color: SOL.base2 }}>{title}</div>
      <div className="mt-1 text-[10.5px]" style={{ color: SOL.base1 }}>{sub}</div>
    </div>
  );
}

function Wire({ label, dir = "right", note }: { label: string; dir?: "right" | "left"; note?: string }) {
  return (
    <div className="flex-1 sm:min-w-[70px] flex sm:flex-col items-center justify-center gap-3 sm:gap-0 py-1.5 sm:py-0 px-1.5">
      <span className="text-[10px] sm:mb-1 order-2 sm:order-none" style={{ color: SOL.base1 }}>{label}</span>
      <span className="relative w-[2px] h-7 sm:w-full sm:h-[2px] order-1 sm:order-none" style={{ backgroundColor: "#3d6c79" }}>
        <span className="hidden sm:block absolute top-1/2 -translate-y-1/2 border-y-[5px] border-y-transparent" style={dir === "right" ? { right: -1, borderLeft: "7px solid #3d6c79" } : { left: -1, borderRight: "7px solid #3d6c79" }} />
        <span className="sm:hidden absolute left-1/2 -translate-x-1/2 border-x-[5px] border-x-transparent" style={dir === "right" ? { bottom: -1, borderTop: "7px solid #3d6c79" } : { top: -1, borderBottom: "7px solid #3d6c79" }} />
      </span>
      {note && <span className="text-[9.5px] sm:mt-1 text-center order-3 sm:order-none" style={{ color: SOL.base01 }}>{note}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 7. Cloud hosts and the desktop pane                                 */
/* ------------------------------------------------------------------ */

export function ElsewhereSection() {
  return (
    <Section
      id="elsewhere"
      label="cloud"
      color={SOL.magenta}
      title="Sessions on a cloud host can borrow your sign-in."
      lede={<>A session on your cloud host has no Chrome of yours. When it needs a site you are signed in to, the agent asks your laptop to carry that one login across, over SSH, into the host&apos;s browser. There is no button for this; the agent does it.</>}
    >
      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 items-start [&>*]:min-w-0">
        <TermShell label="what the agent runs on the host" bodyClassName="px-4 py-3.5">
          <div><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser sync https://grafana.acme.dev</span></div>
          <div style={{ color: SOL.base01 }}># your most recently seen online laptop carries it</div>
          <div><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser sync --via &lt;device-id&gt; --wait 60 &lt;url&gt;</span></div>
          <div><span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>cast browser sync --all</span> <span style={{ color: SOL.base01 }}># every site, refused under an allowlist</span></div>
        </TermShell>
        <ul className="space-y-4 text-[15px] leading-7" style={{ color: SOL.base01 }}>
          <li><Strong>Cookies are never printed.</Strong> The request carries the site&apos;s origin and the answer carries counts.</li>
          <li><Strong>Google is the exception.</Strong> It signs in on its own and cannot be carried.</li>
          <li><Strong>Datacenter IPs get challenged.</Strong> Google and DuckDuckGo may bot-block a host; Bing works.</li>
          <li><Strong>In the desktop app,</Strong> an agent can offer you a page as a pane beside the session.</li>
        </ul>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 8. Command reference                                                */
/* ------------------------------------------------------------------ */

const REFERENCE: { group: string; color: string; rows: [string, string][] }[] = [
  {
    group: "Go", color: CAST_RED, rows: [
      ["open <url>", "The session's tab, created at the URL in the Cast group"],
      ["back · forward · reload", "History"],
      ["tabs [--all]", "This session's tabs, or every agent's"],
      ["tab new · close · switch", "A second page, or another agent's tab on purpose"],
      ["stop", "Close this session's tab"],
    ],
  },
  {
    group: "Read", color: REF_BLUE, rows: [
      ["snapshot -i -s <sel>", "Interactive refs in one region (-c compact, -d depth, -u urls)"],
      ["read [--outline]", "The page, or a URL, as clean text"],
      ["text · get text <sel>", "One element's text, no eval"],
      ["find <text>", "Elements by visible name; namesakes numbered"],
      ["diff snapshot", "Only what changed since the last snapshot"],
    ],
  },
  {
    group: "Act", color: SOL.green, rows: [
      ["click · hover · focus", "On a #eNN ref or a CSS selector"],
      ["type <ref> <text> [--submit]", "Type, then Enter"],
      ["fill · select · press", "Fields, dropdowns, keys"],
      ["scroll · drag · upload", "The rest of the hands"],
      ["wait --text|--url|--fn", "For the state you mean"],
    ],
  },
  {
    group: "Prove", color: SOL.yellow, rows: [
      ["shot [--annotate] [--full]", "Inline in the conversation"],
      ["shot -s <sel> · --share", "One element, or a link to paste elsewhere"],
      ["console · errors", "What the page logged and threw"],
      ["network requests · har", "Requests, routing, HAR capture"],
      ["vitals · a11y · record", "Web Vitals, axe audit, WebM video"],
    ],
  },
  {
    group: "Run", color: SOL.violet, rows: [
      ["do <steps…> | do -", "Many steps, one process (--keep-going)"],
      ["eval <js> | --stdin", "JavaScript in the page; promises awaited"],
      ["viewport <size> [--reset]", "desktop, laptop, wide, tablet, mobile, mobile-small"],
      ["shots on|off", "Auto screenshots after page changes"],
      ["dialogs", "What the page tried to open"],
    ],
  },
  {
    group: "Set up", color: HUMAN_CYAN, rows: [
      ["extension setup · status", "Pair once; check the connection"],
      ["show", "Raise the tab, when you must act"],
      ["audit [--all]", "Origins visited"],
      ["sync [url]", "Carry a login to a cloud host"],
      ["chrome restart · launcher", "Run Chrome so agent tabs keep normal priority"],
    ],
  },
];

export function ReferenceSection() {
  return (
    <Section id="reference" label="for scripts" color={SOL.base01} tone="sand" title="For scripts and agents: every command." lede={<>Agents learn these from their instructions; you only need them to script it yourself. Every verb is <C>cast browser &lt;verb&gt;</C>, and <C>cast browser help &lt;verb&gt;</C> prints its flags.</>}>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-10">
        {REFERENCE.map((g) => (
          <div key={g.group}>
            <div className="flex items-center gap-2 mb-3">
              <GroupChip label={g.group} color={g.color} size="sm" />
            </div>
            <dl className="space-y-2.5">
              {g.rows.map(([cmd, what]) => (
                <div key={cmd}>
                  <dt className="font-mono text-[13px] font-semibold" style={{ color: INK }}>{cmd}</dt>
                  <dd className="text-[13.5px] leading-6" style={{ color: SOL.base01 }}>{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 9. Limits                                                           */
/* ------------------------------------------------------------------ */

const LIMITS: { q: string; a: ReactNode }[] = [
  {
    q: "What does it need?",
    a: <>Desktop Chrome 116 or later, the <a className="underline" href="https://chromewebstore.google.com/detail/codecast/odfpgkdaibmjhhnbndgbjlhdbciciifd" target="_blank" rel="noreferrer">Codecast extension</a> installed in the profile you want agents to use, and paired once with the computer: click <b>Pair</b> on the Browser card in Agent features, or on the setup card that appears under an agent&apos;s step when Chrome is not connected. Chrome has to be running.</>,
  },
  {
    q: "Which pages can it not drive?",
    a: <>Pages Chrome walls off from every extension: <C>chrome://</C>, <C>chrome-extension://</C>, and the Chrome Web Store. <C>open</C> says so before trying, and the agent hands you the URL and the steps instead.</>,
  },
  {
    q: "Why is it sometimes slow?",
    a: <>Chrome throttles background tabs, and on a busy machine a hidden tab can go quiet for tens of seconds. Steps say what they are waiting on rather than hang silently. Restarting Chrome through codecast (<C>cast browser chrome restart</C>) adds the switch that keeps agent tabs at normal priority, and agents batch steps to cut the rest.</>,
  },
  {
    q: "Can an agent read my other tabs?",
    a: <>Agents are told to act only on tabs they opened, and the CLI lists and reuses only the session&apos;s own. The extension does hold Chrome&apos;s debugger permission, since that is what drives a tab, which is why every attached tab is marked, why the connection is local and token proven, and why the audit trail exists.</>,
  },
  {
    q: "What stays with you?",
    a: <>Sign-ins, two-factor codes, and camera, microphone and clipboard prompts. The agent asks; you act in the same tab or through the wheel.</>,
  },
  {
    q: "Is there a separate agent browser?",
    a: <>Only if you explicitly ask for one. Your Chrome is the default every time, including before pairing and after restarts; a missing extension shows you a setup card, never a quiet switch to another browser.</>,
  },
];

export function LimitsSection() {
  return (
    <Section id="limits" label="limits" color={SOL.orange} title="What it does not do, and what it needs.">
      <div className="divide-y rounded-2xl overflow-hidden" style={{ borderColor: "#eadfc2", border: "1px solid #eadfc2", backgroundColor: "#fffaf0" }}>
        {LIMITS.map((l, i) => (
          <details key={l.q} className="group px-5 sm:px-6 py-4" open={i < 2} style={{ borderColor: "#eadfc2" }}>
            <summary className="flex cursor-pointer list-none items-center gap-3 font-mono font-semibold text-[15px] [&::-webkit-details-marker]:hidden" style={{ color: INK }}>
              <span className="inline-block transition-transform group-open:rotate-90" style={{ color: SOL.orange }}>›</span>
              {l.q}
            </summary>
            <p className="mt-2.5 pl-6 text-[15px] leading-7 max-w-3xl" style={{ color: SOL.base01 }}>{l.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* Re-exported so Page.tsx can draw a second Chrome without importing two files. */
export { ChromeWindow };
