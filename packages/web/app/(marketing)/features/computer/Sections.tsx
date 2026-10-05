"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { BLOCKED_APPS, CURSOR_ORANGE, DO_PLAN, DO_RESULTS, DO_WORDS, ERRORS, FLAGS, GRANTS, OUTCOMES, PERMISSIONS_OUT, ROUTES, VERB_GROUPS } from "./data";
import { AgentCursorGlyph, C, HumanCursorGlyph, Lights, Term, TermLineView } from "./parts";

/** Backticks in a recovery line become inline code. */
function Ticks({ s, dark = false }: { s: string; dark?: boolean }) {
  return (
    <>
      {s.split(/(`[^`]+`)/).map((p, i) =>
        p.startsWith("`") ? (
          <code key={i} className="font-mono text-[0.92em] px-1 rounded" style={{ backgroundColor: dark ? SOL.base02 : SOL.base2, color: dark ? SOL.base1 : SOL.base02 }}>{p.slice(1, -1)}</code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/* ── Every action says what it changed ─────────────────────────────────── */

const VERDICT_COLOR = { completed: SOL.green, attempted: SOL.cyan, ignored: SOL.yellow } as const;

export function OutcomesDemo() {
  const [pick, setPick] = useState(1);
  const o = OUTCOMES[pick];
  return (
    <div className="grid-cols-1 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] items-start">
      <div className="flex lg:flex-col gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="Action outcomes">
        {OUTCOMES.map((x, i) => {
          const on = i === pick;
          return (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setPick(i)}
              className="cx-tab shrink-0 lg:shrink text-left rounded-xl px-4 py-3 border min-w-[200px] lg:min-w-0"
              style={{ backgroundColor: on ? SOL.base03 : "transparent", borderColor: on ? SOL.base03 : SOL.base2, color: on ? SOL.base2 : SOL.base00 }}
            >
              <span className="flex items-center gap-2 font-mono text-[12px]">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: VERDICT_COLOR[x.verdict] }} />
                {x.tab}
              </span>
              <span className="mt-1 block text-[14px] font-semibold leading-snug" style={{ color: on ? SOL.base3 : SOL.base02 }}>{x.title}</span>
            </button>
          );
        })}
      </div>
      <div key={o.key} className="cx-swap">
        <Term label="the action's own output">
          <TermLineView line={{ t: "cmd", s: o.cmd }} />
          <div className="h-2" />
          {o.lines.map((l, i) => <TermLineView key={i} line={l} />)}
          <div className="mt-4 pt-3" style={{ borderTop: "1px dashed #0b4a5a" }}>
            <div style={{ color: SOL.base01 }}>with --json</div>
            <div style={{ color: SOL.violet }}>{o.json}</div>
          </div>
        </Term>
        <p className="mt-5 text-[16px] leading-[1.7] max-w-2xl" style={{ color: SOL.base00 }}>{o.body}</p>
      </div>
    </div>
  );
}

/* ── You keep your screen ──────────────────────────────────────────────── */

export function TwoCursors({ still }: { still: boolean }) {
  return (
    <div className="rounded-2xl overflow-hidden relative select-none" style={{ aspectRatio: "16 / 9", background: `radial-gradient(60% 80% at 15% 20%, rgba(42,161,152,0.45), transparent 70%), radial-gradient(60% 80% at 90% 90%, rgba(211,54,130,0.35), transparent 70%), linear-gradient(160deg, #0a4a5a, #1a2f45)` }} role="img" aria-label="Two windows: the human's frontmost window with their black pointer, and a background window where the orange agent cursor works.">
      <div className="absolute inset-0 text-[clamp(7px,1.25vw,13px)]" style={{ containerType: "inline-size" }}>
        {/* background window: the agent's */}
        <div className="absolute rounded-[0.9em] overflow-hidden" style={{ left: "6%", top: "10%", width: "54%", height: "70%", backgroundColor: "#ece7da", boxShadow: "0 1.4em 3em -1em rgba(0,0,0,0.5)" }}>
          <div className="flex items-center gap-[0.8em] px-[1em]" style={{ height: "2.6em", backgroundColor: "#e3ddce" }}>
            <Lights active={false} />
            <span className="font-sans text-[1.05em]" style={{ color: "#8b8577" }}>Spotify</span>
          </div>
          <div className="p-[1.2em] space-y-[0.7em]">
            {[78, 64, 70, 52, 66].map((w, i) => (
              <div key={i} className="flex items-center gap-[0.8em]">
                <span className="w-[2.2em] h-[2.2em] rounded-[0.3em]" style={{ backgroundColor: i === 2 ? "#1db954" : "#d4cdbd" }} />
                <span className="h-[0.7em] rounded-full" style={{ width: `${w}%`, backgroundColor: "#d4cdbd" }} />
              </div>
            ))}
          </div>
        </div>
        {/* front window: the human's */}
        <div className="absolute rounded-[0.9em] overflow-hidden" style={{ left: "44%", top: "26%", width: "50%", height: "64%", backgroundColor: "#fffdf6", boxShadow: "0 2em 4em -1em rgba(0,0,0,0.6)" }}>
          <div className="flex items-center gap-[0.8em] px-[1em]" style={{ height: "2.6em", backgroundColor: "#f6f1e3" }}>
            <Lights active />
            <span className="font-sans text-[1.05em]" style={{ color: "#6b665b" }}>Mail</span>
          </div>
          <div className="p-[1.4em] space-y-[0.6em]">
            {[90, 84, 92, 40].map((w, i) => <div key={i} className="h-[0.7em] rounded-full" style={{ width: `${w}%`, backgroundColor: "#ebe5d6" }} />)}
          </div>
          <div className={`absolute ${still ? "" : "cx-drift-b"}`} style={{ left: "58%", top: "58%" }}>
            <HumanCursorGlyph />
          </div>
        </div>
        {/* The agent cursor works in the background window but draws above every window, as the real one does. */}
        <div className={`absolute z-10 ${still ? "" : "cx-drift-a"}`} style={{ left: "22%", top: "41%" }}>
          <AgentCursorGlyph size={0.9} />
        </div>
      </div>
    </div>
  );
}

export function RoutesTable() {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${SOL.base2}` }}>
      {ROUTES.map((r, i) => (
        <div key={i} className="grid sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)] gap-x-6 gap-y-1 px-4 sm:px-5 py-4" style={{ borderTop: i ? `1px solid ${SOL.base2}` : undefined, backgroundColor: r.background ? "transparent" : "rgba(181,137,0,0.07)" }}>
          <div>
            <div className="font-mono text-[12.5px]" style={{ color: SOL.base02 }}>{r.verbs}</div>
            <div className="mt-1 flex items-center gap-2 text-[12px] font-mono">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: r.background ? SOL.green : SOL.yellow }} />
              <span style={{ color: r.background ? SOL.green : SOL.yellow }}>{r.background ? "background window" : "needs the window in front"}</span>
            </div>
          </div>
          <div className="text-[14.5px] leading-relaxed" style={{ color: SOL.base00 }}>
            <span className="font-mono text-[12px] mr-1.5" style={{ color: SOL.base1 }}>via {r.path}.</span>
            {r.note}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Batched flows ─────────────────────────────────────────────────────── */

export function BatchDemo() {
  return (
    <div className="grid-cols-1 grid gap-5 lg:grid-cols-2 items-start">
      <Term label="one process, one helper connection">
        <TermLineView line={{ t: "cmd", s: "cast computer do --app com.apple.Preview - <<'EOF'" }} />
        {DO_PLAN.map((s, i) => <div key={i} className="cx-tl" style={{ color: SOL.base1, paddingLeft: "1.2ch" }}>{s}</div>)}
        <div className="cx-tl" style={{ color: SOL.base1, paddingLeft: "1.2ch" }}>EOF</div>
      </Term>
      <Term label="what it prints (abbreviated)">
        {DO_RESULTS.map((r, i) => (
          <div key={i} className={i ? "mt-2" : ""}>
            <div><span style={{ color: SOL.green }}>✓</span> <span style={{ color: SOL.base2 }}>{r.step}</span></div>
            {r.first && <div className="cx-tl" style={{ color: SOL.cyan, paddingLeft: "4ch" }}>{r.first}</div>}
          </div>
        ))}
      </Term>
    </div>
  );
}

export function StepWords() {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DO_WORDS.map((w) => (
        <span key={w} className="font-mono text-[12px] px-2 py-1 rounded-md" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>{w}</span>
      ))}
    </div>
  );
}

/* ── Guardrails ────────────────────────────────────────────────────────── */

export function Guardrails() {
  return (
    <div className="grid-cols-1 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {/* Blocked apps */}
      <div className="rounded-2xl p-6" style={{ backgroundColor: SOL.base02, border: "1px solid #0b4a5a" }}>
        <div className="font-mono text-[12px]" style={{ color: SOL.red }}>app_blocked</div>
        <h3 className="mt-2 font-mono font-bold text-[19px]" style={{ color: SOL.base2 }}>Password managers are refused</h3>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: SOL.base1 }}>
          The helper itself refuses these, under any name you pass. The CLI is not the line of defence, so no flag turns it off.
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {BLOCKED_APPS.map((a) => (
            <span key={a} className="font-mono text-[12px] px-2 py-1 rounded-md line-through decoration-[1.5px]" style={{ backgroundColor: "rgba(220,50,47,0.12)", color: "#f08c8a", textDecorationColor: SOL.red }}>{a}</span>
          ))}
        </div>
      </div>

      {/* Redaction */}
      <div className="rounded-2xl p-6" style={{ backgroundColor: SOL.base02, border: "1px solid #0b4a5a" }}>
        <div className="font-mono text-[12px]" style={{ color: SOL.cyan }}>[redacted]</div>
        <h3 className="mt-2 font-mono font-bold text-[19px]" style={{ color: SOL.base2 }}>Secret fields never print</h3>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: SOL.base1 }}>
          A password, passcode or one-time code field shows as <span className="font-mono" style={{ color: SOL.base2 }}>[redacted]</span> in every tree, so its value never reaches the agent&apos;s context or your transcript.
        </p>
        <div className="mt-4 rounded-lg px-3 py-2.5 font-mono text-[12px] leading-[1.7]" style={{ backgroundColor: SOL.base03 }}>
          <div style={{ color: SOL.base0 }}><span style={{ color: SOL.yellow }}>14</span> text field Email, Value: sam@example.com</div>
          <div style={{ color: SOL.base0 }}><span style={{ color: SOL.yellow }}>15</span> secure text field Password, Value: <span style={{ color: SOL.cyan }}>[redacted]</span></div>
        </div>
      </div>

      {/* stdin */}
      <div className="md:col-span-2 lg:col-span-1 rounded-2xl p-6" style={{ backgroundColor: SOL.base02, border: "1px solid #0b4a5a" }}>
        <div className="font-mono text-[12px]" style={{ color: SOL.violet }}>--value-stdin</div>
        <h3 className="mt-2 font-mono font-bold text-[19px]" style={{ color: SOL.base2 }}>Secrets go in through stdin</h3>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: SOL.base1 }}>
          <span className="font-mono">--text-stdin</span> and <span className="font-mono">--value-stdin</span> keep a token out of shell history and <span className="font-mono">ps</span>. Passing both a flag and stdin, or stdin from a terminal, is an error rather than a guess.
        </p>
        <div className="mt-4 rounded-lg px-3 py-2.5 font-mono text-[12px] leading-[1.7] break-words" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
          <span style={{ color: SOL.green }}>$</span> printf &apos;%s&apos; &quot;$TOKEN&quot; | cast computer set-value --app &lt;app&gt; --element-index 42 --value-stdin
        </div>
      </div>

      {/* The behaviour rule: a band across both columns */}
      <div className="md:col-span-2 lg:col-span-3 rounded-2xl p-6 sm:p-8 grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-center" style={{ backgroundColor: "color-mix(in srgb, #b58900 10%, #073642)", border: "1px solid rgba(181,137,0,0.35)" }}>
        <div>
          <div className="font-mono text-[12px]" style={{ color: SOL.yellow }}>the behaviour rule</div>
          <h3 className="mt-2 font-mono font-bold text-[21px] sm:text-[24px] leading-tight" style={{ color: SOL.base2 }}>Reading is the agent&apos;s. Leaving a mark is yours.</h3>
          <p className="mt-3 text-[15px] leading-relaxed" style={{ color: SOL.base1 }}>
            Every agent with codecast installed carries the same standing instruction: do not push, submit a form, send a message, buy anything, delete data or change account settings unless you asked for that action. In an app holding sensitive content, read only what you were asked to read.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-px rounded-xl overflow-hidden font-mono text-[12.5px]" style={{ backgroundColor: "rgba(147,161,161,0.18)" }}>
          <div className="px-4 py-2 text-[11px]" style={{ backgroundColor: SOL.base03, color: SOL.base01 }}>agent does</div>
          <div className="px-4 py-2 text-[11px]" style={{ backgroundColor: SOL.base03, color: SOL.base01 }}>waits for you to ask</div>
          {[["read a window", "send a message"], ["find a button", "submit a form"], ["write a draft", "buy anything"], ["take a screenshot", "delete data"], ["report what it saw", "change settings"]].map(([a, b]) => (
            <div key={a} className="contents">
              <div className="px-4 py-2" style={{ backgroundColor: SOL.base03, color: SOL.green }}>✓ {a}</div>
              <div className="px-4 py-2" style={{ backgroundColor: SOL.base03, color: "#f08c8a" }}>✕ {b}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Errors with recoveries ────────────────────────────────────────────── */

export function ErrorList() {
  return (
    <div className="grid-cols-1 grid gap-2 md:grid-cols-2 items-start">
      {ERRORS.map((e, i) => (
        <details key={e.code} className="cx-err group rounded-xl" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }} open={i === 3}>
          <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none">
            <span className="cx-err-chev font-mono text-[12px]" style={{ color: SOL.base1 }}>▸</span>
            <span className="font-mono text-[13.5px] font-semibold" style={{ color: SOL.magenta }}>{e.code}</span>
            <span className="ml-auto font-mono text-[11px] hidden sm:inline" style={{ color: SOL.base1 }}>{e.recovery.length} step{e.recovery.length === 1 ? "" : "s"}</span>
          </summary>
          <ol className="px-4 pb-4 pl-11 space-y-1.5 list-decimal text-[14px] leading-relaxed" style={{ color: SOL.base00 }}>
            {e.recovery.map((r, j) => <li key={j}><Ticks s={r} /></li>)}
          </ol>
        </details>
      ))}
    </div>
  );
}

/* ── Setup ─────────────────────────────────────────────────────────────── */

export function SetupPanel() {
  return (
    <div className="grid-cols-1 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
      <div className="space-y-4">
        {GRANTS.map((g, i) => (
          <div key={g.id} className="rounded-2xl p-5 flex gap-4" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
            <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center font-mono text-[14px] font-bold" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>{i + 1}</span>
            <div>
              <div className="font-mono font-bold text-[16px]" style={{ color: SOL.base02 }}>{g.name} <span className="font-normal text-[12px] whitespace-nowrap" style={{ color: SOL.base1 }}>--id {g.id}</span></div>
              <p className="mt-1.5 text-[15px] leading-relaxed" style={{ color: SOL.base00 }}>{g.why}</p>
            </div>
          </div>
        ))}
        <p className="text-[15px] leading-relaxed" style={{ color: SOL.base00 }}>
          <C>cast computer setup</C> is the human&apos;s one command for both. It explains each grant, asks before anything appears, opens only the pane that is still missing and waits for the grant to land. A machine that is already granted goes through it without a window moving. Interrupt it with <KeyCap>Ctrl</KeyCap> <KeyCap>C</KeyCap>.
        </p>
      </div>
      <div className="space-y-4">
        <Term label="silent read: shows nothing on screen">
          <TermLineView line={{ t: "cmd", s: "cast computer permissions" }} />
          {PERMISSIONS_OUT.map((l, i) => <TermLineView key={i} line={{ t: i ? "dim" : "ok", s: l }} />)}
        </Term>
        <div className="rounded-2xl p-5" style={{ backgroundColor: "#f6efda", border: `1px solid ${SOL.base2}` }}>
          <div className="font-mono font-bold text-[15px]" style={{ color: SOL.base02 }}>Linux hosts</div>
          <p className="mt-1.5 text-[15px] leading-relaxed" style={{ color: SOL.base00 }}>
            On Linux under X11 the same verbs run through AT-SPI and a small helper the CLI writes to <span className="font-mono text-[13px]">~/.codecast/computer/linux/</span>. It answers the same protocol as the Mac helper, so trees, diffs and filters read the same. <C>--app</C> takes the window&apos;s WM_CLASS there, such as <C>google-chrome</C>.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Command reference ─────────────────────────────────────────────────── */

export function Reference() {
  return (
    <div className="grid-cols-1 grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="sm:columns-2 gap-8">
        {VERB_GROUPS.map((g) => (
          <div key={g.name} className="break-inside-avoid mb-8">
            <div className="font-mono text-[12px] pb-2" style={{ color: SOL.base01, borderBottom: `1px solid ${SOL.base02}` }}>{g.name}</div>
            <dl className="mt-3 space-y-3">
              {g.verbs.map(([v, d]) => (
                <div key={v}>
                  <dt className="font-mono text-[13.5px]" style={{ color: SOL.cyan }}>{v}</dt>
                  <dd className="text-[14px] leading-snug mt-0.5" style={{ color: SOL.base1 }}>{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <div>
        <div className="font-mono text-[12px] pb-2" style={{ color: SOL.base01, borderBottom: `1px solid ${SOL.base02}` }}>Flags that matter</div>
        <dl className="mt-3 space-y-3">
          {FLAGS.map(([f, d]) => (
            <div key={f}>
              <dt className="font-mono text-[13px]" style={{ color: SOL.yellow }}>{f}</dt>
              <dd className="text-[14px] leading-snug mt-0.5" style={{ color: SOL.base1 }}>{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export { CURSOR_ORANGE };
