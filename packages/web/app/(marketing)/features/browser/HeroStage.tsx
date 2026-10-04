"use client";

import { useRef, useState, type ReactNode } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";
import { ChromeWindow } from "./ChromeWindow";
import { CARD, CheckoutPage, type CheckoutPhase } from "./Checkout";
import { Scaled, AgentCursor, CAST_RED, EYE_ICON, GLOBE_ICON, HUMAN_CYAN, OPEN_TAB_ICON, RowPill, TermShell, useStepClock, useStillMode } from "./kit";

/**
 * The hero: one agent verifies a checkout fix on staging, in the human's own
 * Chrome, while the human keeps writing in their own tab.
 *
 * The window's front tab stays the human's doc the whole time. The agent's
 * tab lives in the red Cast group, in the background, so the page it drives
 * is drawn as a sheet lifted out of that tab. The terminal runs one `cast
 * browser do` flow; the page answers each step; the wait fails, and the
 * failure context and the screenshot land in the conversation.
 */

/** ms each step holds. */
const STEP_MS = [1500, 1300, 1400, 2100, 1900, 1300, 2300, 5200];
const LAST = STEP_MS.length - 1;

const CHAPTERS: { label: string; step: number }[] = [
  { label: "open", step: 1 },
  { label: "snapshot", step: 3 },
  { label: "fill", step: 4 },
  { label: "click", step: 5 },
  { label: "wait", step: 6 },
  { label: "evidence", step: 7 },
];

const PHASE_AT: CheckoutPhase[] = [0, 0, 1, 2, 3, 4, 5, 5];

type Line = { at: number; node: ReactNode };

const g = (s: string) => <span style={{ color: SOL.green }}>{s}</span>;
const dim = (s: string) => <span style={{ color: SOL.base01 }}>{s}</span>;
const hi = (s: string) => <span style={{ color: SOL.base2 }}>{s}</span>;
const blue = (s: string) => <span style={{ color: SOL.blue }}>{s}</span>;
const red = (s: string) => <span style={{ color: "#ff6f61" }}>{s}</span>;
const yel = (s: string) => <span style={{ color: SOL.yellow }}>{s}</span>;

const LINES: Line[] = [
  { at: 0, node: <>{g("$")} {hi("cast browser do - <<'EOF'")}</> },
  { at: 0, node: <>{dim("  ")}open https://staging.acme.dev/checkout</> },
  { at: 0, node: <>{dim("  ")}snapshot -i -s main</> },
  { at: 0, node: <>{dim("  ")}fill {blue("#e4")} &quot;{CARD}&quot;</> },
  { at: 0, node: <>{dim("  ")}click {blue("#e7")}</> },
  { at: 0, node: <>{dim("  ")}wait --text &quot;Order confirmed&quot;</> },
  { at: 0, node: <>{dim("  EOF")}</> },
  { at: 1, node: <>{dim("›")} open https://staging.acme.dev/checkout</> },
  { at: 2, node: <>{g("✓")} {hi("Checkout · Acme")}</> },
  { at: 3, node: <>{dim("›")} snapshot -i -s main</> },
  { at: 3, node: <>{dim("- textbox")} &quot;Email&quot; {blue("[ref=e3]")}</> },
  { at: 3, node: <>{dim("- textbox")} &quot;Card number&quot; {blue("[ref=e4]")}</> },
  { at: 3, node: <>{dim("- combobox")} &quot;Shipping&quot; {blue("[ref=e5]")}</> },
  { at: 3, node: <>{dim("- checkbox")} &quot;Save this card&quot; {blue("[ref=e6]")}</> },
  { at: 3, node: <>{dim("- button")} &quot;Place order&quot; {blue("[ref=e7]")}</> },
  { at: 4, node: <>{dim("›")} fill {blue("#e4")} &quot;{CARD}&quot;</> },
  { at: 5, node: <>{dim("›")} click {blue("#e7")}</> },
  { at: 6, node: <>{dim("›")} wait --text &quot;Order confirmed&quot;</> },
  { at: 6, node: <>{red("✗")} {hi("\"Order confirmed\" never appeared")}</> },
  { at: 6, node: <>{dim("── failure context ────────────────")}</> },
  { at: 6, node: <>console errors (newest first):</> },
  { at: 6, node: <>{dim("  +6.1s")} {red("ERR")} TypeError: Cannot read properties of undefined (reading &apos;id&apos;)</> },
  { at: 6, node: <>failed requests (newest first):</> },
  { at: 6, node: <>{dim("  ")}{red("500")} POST     812ms https://staging.acme.dev/api/orders</> },
  { at: 7, node: <>{yel("▣")} {dim("screenshot → inline in the conversation")}</> },
];

export function HeroStage() {
  const still = useStillMode();
  const [playing, setPlaying] = useState(true);
  const [step, setStep] = useStepClock(STEP_MS, still, playing);
  const [typed, setTyped] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Type the card number during the fill step.
  useWatchEffect(() => {
    if (step !== 4) { setTyped(step > 4 ? CARD.length : 0); return; }
    if (still || typed >= CARD.length) return;
    const t = setTimeout(() => setTyped(typed + 1), 55);
    return () => clearTimeout(t);
  }, [step, typed, still]);

  // Glide the agent's cursor to the element each step acts on.
  useWatchEffect(() => {
    const measure = () => {
      const sheet = sheetRef.current;
      const target = step === 4 ? cardRef.current : step >= 5 ? buttonRef.current : null;
      if (!sheet || !target) { setCursor(null); return; }
      const a = sheet.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      setCursor({ x: b.left - a.left + b.width * (step === 4 ? 0.62 : 0.52), y: b.top - a.top + b.height * 0.55 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step]);

  const phase = PHASE_AT[step];
  const castTab = step >= 1;
  const evidence = step === LAST;

  return (
    <div className={`relative ${still ? "bx-still" : ""}`}>
      <div className="relative lg:h-[750px]">
        {/* Chrome: the human's window. */}
        <div className="relative lg:absolute lg:left-0 lg:top-0 lg:w-[64%] h-[460px] sm:h-[500px] lg:h-[520px] z-[1]">
          <ChromeWindow
            className="h-full"
            humanActive={1}
            showGroup={castTab}
            castTabs={[{ title: step >= 2 ? "Checkout · Acme" : "staging.acme.dev", loading: step === 1 }]}
            url="docs.acme.dev/q4-roadmap"
            compact
          >
            <HumanDoc />
            {/* The background Cast tab, lifted out of the strip. */}
            {castTab && (
              <div className="bx-pop absolute left-[5%] sm:left-[17%] right-3 top-4 bottom-3 flex flex-col">
                <div className="flex items-center gap-2 pb-1.5 text-[10.5px] font-mono" style={{ color: CAST_RED }}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CAST_RED }} />
                  <span className="truncate">background tab · Cast group · staging.acme.dev/checkout</span>
                </div>
                <div
                  ref={sheetRef}
                  className="relative flex-1 min-h-0 rounded-lg overflow-hidden"
                  style={{ boxShadow: `0 0 0 1.5px ${CAST_RED}, 0 24px 50px -20px rgba(0,43,54,.5)` }}
                >
                  {step === 1 && <span className="bx-load absolute left-0 right-0 top-0 h-[2px] z-10" style={{ backgroundColor: "#1a73e8" }} />}
                  <CheckoutPage phase={phase} typed={typed} cardRef={cardRef} buttonRef={buttonRef} />
                  {cursor && <AgentCursor x={`${cursor.x}px`} y={`${cursor.y}px`} pressing={step === 5} />}
                  {evidence && !still && <span key="shutter" className="bx-shutter absolute inset-0 bg-white z-30" />}
                </div>
              </div>
            )}
          </ChromeWindow>
        </div>

        {/* The agent's terminal. */}
        <div className="relative mt-4 lg:mt-0 lg:absolute lg:right-0 lg:top-[120px] lg:w-[37%] z-[2]">
          <TermShell label="claude · ~/src/shop" bodyClassName="h-[300px] sm:h-[330px] lg:h-[400px] px-3.5 py-3 flex flex-col justify-end overflow-hidden">
            {LINES.filter((l) => l.at <= step).map((l, i) => (
              <div key={i} className={`whitespace-pre-wrap break-words ${l.at === step && step > 0 ? "bx-fade" : ""}`}>{l.node}</div>
            ))}
            {!evidence && <div><span className="bx-caret" style={{ color: SOL.base01 }} /></div>}
          </TermShell>
        </div>

        {/* The conversation: where the evidence lands. */}
        <div
          className={`relative mt-4 lg:mt-0 lg:absolute lg:left-[16%] lg:top-[500px] lg:w-[46%] z-[3] transition-all duration-500 ${evidence ? "lg:opacity-100 lg:translate-y-0" : "lg:opacity-0 lg:translate-y-6"}`}
        >
          <ThreadCard live={evidence} />
        </div>
      </div>

      {/* Chapter scrubber */}
      <div className="mt-6 flex flex-wrap items-center gap-2 justify-center">
        <button
          type="button"
          onClick={() => setPlaying(!playing)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors hover:bg-[#eee8d5]"
          style={{ borderColor: "rgba(147,161,161,.6)", color: SOL.base01 }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing && !still ? (
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z" /></svg>
          )}
        </button>
        {CHAPTERS.map((c, i) => {
          const next = CHAPTERS[i + 1]?.step ?? LAST + 1;
          const on = step >= c.step && step < next;
          const done = step >= next;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => { setPlaying(false); setStep(c.step); }}
              className="rounded-full border px-3 py-1 text-[12px] font-mono transition-colors"
              style={on
                ? { backgroundColor: CAST_RED, borderColor: CAST_RED, color: "#fff" }
                : { borderColor: done ? "rgba(220,50,47,.4)" : "rgba(147,161,161,.5)", color: done ? CAST_RED : SOL.base01 }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The human's own front tab: a doc they keep writing in, with their cyan caret. */
function HumanDoc() {
  return (
    <div className="absolute inset-0 px-5 sm:px-7 py-6 font-sans" style={{ backgroundColor: "#f8f9fb" }}>
      <div className="max-w-[420px] rounded-md bg-white px-5 py-5 shadow-[0_1px_3px_rgba(0,0,0,.08)] h-full">
        <div className="text-[15px] font-semibold text-[#1f1f1f]">Q4 roadmap</div>
        <div className="mt-3 space-y-2">
          {[92, 80, 86, 40].map((w, i) => <div key={i} className="h-[7px] rounded bg-[#e5e8ec]" style={{ width: `${w}%` }} />)}
        </div>
        <div className="mt-4 text-[11px] text-[#3c4043]">
          Ship checkout v2<span className="inline-block w-[1.5px] h-3 ml-[1px] align-middle bx-blink-human" style={{ backgroundColor: HUMAN_CYAN }} />
        </div>
        <div className="mt-3 space-y-2">
          {[70, 88, 60].map((w, i) => <div key={i} className="h-[7px] rounded bg-[#eceef1]" style={{ width: `${w}%` }} />)}
        </div>
      </div>
    </div>
  );
}

/**
 * The conversation row the flow becomes: the `browser do` row with its
 * "open tab" and "watch" pills, the failure screenshot under it, the failure
 * context, and the agent's next sentence.
 */
function ThreadCard({ live }: { live: boolean }) {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-left shadow-[0_30px_60px_-28px_rgba(0,43,54,.55)]" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8" }}>
      <div className="flex items-center gap-2 px-3 py-2 text-[11px]" style={{ borderBottom: "1px solid rgba(147,161,161,.18)" }}>
        <span className="font-medium truncate" style={{ color: SOL.base03 }}>Verify the order fix on staging</span>
        <span className="flex items-center gap-1 shrink-0" style={{ color: SOL.green }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.green }} /> working
        </span>
        <span className="ml-auto text-[11px] font-medium shrink-0" style={{ color: SOL.blue }}>claude</span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="flex items-center gap-1" style={{ color: SOL.blue }}>{GLOBE_ICON} browser do</span>
          <span className="truncate" style={{ color: SOL.base00 }}>5 steps · stopped at wait</span>
          <span className="ml-auto flex gap-1">
            <RowPill>{OPEN_TAB_ICON} open tab</RowPill>
            <RowPill>{EYE_ICON} watch</RowPill>
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,150px)_1fr] sm:grid-cols-[180px_1fr] gap-2.5 items-start">
          <Thumb />
          <div className="text-[9.5px] leading-[1.55] min-w-0" style={{ color: SOL.base01 }}>
            <div><span style={{ color: CAST_RED }}>ERR</span> TypeError: Cannot read properties of undefined (reading &apos;id&apos;)</div>
            <div className="mt-1"><span style={{ color: CAST_RED }}>500</span> POST /api/orders · 812ms</div>
          </div>
        </div>
        <p className={`text-[11.5px] leading-relaxed font-sans ${live ? "bx-fade" : ""}`} style={{ color: SOL.base02 }}>
          The order POST returns 500 on staging and the page throws reading the empty response, so the fix never reached this build. Checking the API logs next.
        </p>
      </div>
    </div>
  );
}

/** The screenshot: the same checkout component at its failed frame, scaled down. */
function Thumb() {
  return <Scaled w={720} h={400}><CheckoutPage phase={5} refs={false} thumb /></Scaled>;
}
