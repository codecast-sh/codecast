"use client";

import { useState } from "react";
import Link from "next/link";
import { SOL, Terminal } from "../../blog/blogChrome";
import { BrowserFrame, CYAN, PageBar, SITE, delay } from "./kit";

const SLUG = "k3Vd9QpLm2Xa";
const URL = `${SITE}${SLUG}`;

/** The report body every sheet in the deck shows, with the newest one's edits. */
function ReportBody({ v }: { v: 1 | 2 | 3 }) {
  const bars = v === 1 ? [62, 48, 30, 22] : [62, 48, 30, 22, 14];
  return (
    <div className="px-5 sm:px-7 pt-5 pb-6 text-left">
      <div className="font-mono text-[10px]" style={{ color: SOL.base1 }}>churn-audit.md</div>
      <div className="mt-1 font-mono font-bold text-[17px] sm:text-[19px] tracking-tight" style={{ color: SOL.base03 }}>Q3 churn audit</div>
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-5 items-end">
        <div className="space-y-1.5 text-[12px] leading-[1.6]" style={{ color: SOL.base01 }}>
          <p>Churn rose from 3.1% to 4.4% between July and September. Most of the increase sits in accounts under 90 days old.</p>
          <p>
            {v === 3 ? (
              <span>
                <span className="pb-hl pb-anim pb-mark" style={delay(4.0)}>Accounts that never connected a second repo churned at twice the rate.</span>
                <span
                  className="pb-anim pb-pin ml-1 relative -top-1 align-middle inline-flex h-5 w-5 items-center justify-center rounded-full rounded-bl-none text-[9px] font-bold text-white"
                  style={delay(4.25, { backgroundColor: CYAN, boxShadow: "0 3px 8px rgba(0,43,54,.25)" })}
                >2</span>
              </span>
            ) : (
              <span>Accounts that never connected a second repo churned at twice the rate.</span>
            )}
          </p>
        </div>
        <svg width="96" height="70" viewBox="0 0 96 70" aria-label="Bar chart of churn by cohort" className="shrink-0">
          {bars.map((h, i) => (
            <rect key={i} x={i * 19 + 2} y={68 - h} width="13" height={h} rx="2" fill={i === 0 ? CYAN : "rgba(42,161,152,.35)"} />
          ))}
          <line x1="0" y1="68.5" x2="96" y2="68.5" stroke="rgba(88,110,117,.3)" />
        </svg>
      </div>
      <div className="mt-4 h-1.5 w-11/12 rounded-full" style={{ backgroundColor: SOL.base2 }} />
      <div className="mt-2 h-1.5 w-3/4 rounded-full" style={{ backgroundColor: SOL.base2 }} />
      {v >= 2 && <div className="mt-2 h-1.5 w-5/6 rounded-full" style={{ backgroundColor: SOL.base2 }} />}
    </div>
  );
}

/** One version sheet in the deck. Older sheets sit lower and to the right, so their edge and tag peek out. */
function Sheet({ v, offset, d, front = false }: { v: 1 | 2 | 3; offset: number; d: number; front?: boolean }) {
  return (
    <div className="absolute inset-x-0 top-0" style={{ transform: `translate(${offset}px, ${offset * 1.1}px)`, zIndex: v }}>
      <div className="pb-anim pb-drop" style={delay(d)}>
        <BrowserFrame
          url={URL}
          urlNode={
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate">{URL}</span>
              {front && <span className="pb-anim pb-pulse ml-auto h-1.5 w-1.5 rounded-full shrink-0" style={delay(3.0, { backgroundColor: CYAN })} />}
            </span>
          }
          style={front ? undefined : { boxShadow: "0 10px 30px -18px rgba(0,43,54,.35)" }}
        >
          <PageBar title="Q3 churn audit" session="Churn analysis" when="Oct 4, 2026" version={`v${v}`} comments={v === 3 ? 2 : 0} />
          <ReportBody v={v} />
        </BrowserFrame>
        {!front && (
          <span
            className="absolute -bottom-[1px] right-4 translate-y-full rounded-b-md px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{ backgroundColor: SOL.base2, color: SOL.base01, border: "1px solid rgba(88,110,117,.25)", borderTop: "none" }}
          >v{v}</span>
        )}
      </div>
    </div>
  );
}

/** The comment a viewer left on the highlighted sentence, as the page owner sees it. */
function CommentPopover() {
  return (
    <div
      className="pb-anim pb-rise absolute z-30 w-[236px] rounded-lg border bg-white text-left shadow-xl right-2 sm:-right-6 lg:-right-10 top-[206px] sm:top-[216px]"
      style={delay(4.55, { borderColor: "rgba(88,110,117,.25)" })}
    >
      <div className="px-3 pt-2.5 pb-2 border-b" style={{ borderColor: SOL.base2 }}>
        <div className="font-mono text-[9.5px] truncate" style={{ color: SOL.base1 }}>&ldquo;Accounts that never connected a second&hellip;&rdquo;</div>
        <div className="mt-1.5 text-[12px] leading-snug" style={{ color: SOL.base02 }}>
          <span className="font-semibold">Maya</span> Can you split this by plan tier?
        </div>
        <div className="mt-1.5 text-[12px] leading-snug" style={{ color: SOL.base02 }}>
          <span className="font-semibold">Jon</span> And show the September cohort alone.
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-mono text-[9.5px]" style={{ color: SOL.base1 }}>2 pending</span>
        <span className="rounded-md px-2 py-1 font-mono text-[10.5px] font-semibold text-white" style={{ backgroundColor: SOL.base03 }}>Send all</span>
      </div>
    </div>
  );
}

function WatchTerminal() {
  const line = (d: number, children: React.ReactNode) => <span className="pb-anim pb-rise block" style={delay(d)}>{children}</span>;
  return (
    <div className="[&>div]:my-0 [&_pre]:text-[11px] sm:[&_pre]:text-[11.5px]">
      <Terminal label="~/work/churn">
        <span className="pb-anim pb-type inline-block" style={delay(0.2)}>
          <span style={{ color: SOL.green }}>$</span>
          <span style={{ color: SOL.base1 }}> cast publish churn-audit.md --watch</span>
        </span>
        {"\n"}
        {line(1.1, <><span style={{ color: SOL.green }}>✓</span> <span style={{ color: SOL.base2 }}>Q3 churn audit</span>  <span style={{ color: SOL.yellow }}>v1</span> → published</>)}
        {line(1.2, <>  <span style={{ color: CYAN }}>https://{URL}</span></>)}
        {line(1.3, <>  <span style={{ color: SOL.base01 }}>manage (owner link — keep private):</span> …</>)}
        {"\n"}
        {line(1.55, <span style={{ color: SOL.base01 }}>watching churn-audit.md — Ctrl+C to stop</span>)}
        {line(1.65, <span style={{ color: SOL.base01 }}>live view: …/{SLUG}?live=1</span>)}
        {line(2.15, <>  10:42:07  <span style={{ color: SOL.yellow }}>v2</span> → updated</>)}
        {line(3.15, <>  10:44:31  <span style={{ color: SOL.yellow }}>v3</span> → updated</>)}
        <span className="pb-caret" />
      </Terminal>
    </div>
  );
}

function CopyCommand() {
  const [copied, setCopied] = useState(false);
  const cmd = "cast publish report.html";
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(cmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="pb-copy group inline-flex items-center gap-3 rounded-lg px-4 h-12 font-mono text-[14px] transition-transform"
      style={{ backgroundColor: SOL.base03, color: SOL.base2 }}
      aria-label="Copy the command"
    >
      <span style={{ color: SOL.green }}>$</span>
      <span>{cmd}</span>
      <span className="ml-2 text-[11px] rounded px-1.5 py-0.5 transition-colors" style={{ color: copied ? SOL.base03 : SOL.base1, backgroundColor: copied ? CYAN : "rgba(147,161,161,.15)" }}>
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}

export function Hero() {
  return (
    <header className="pb-paper relative overflow-hidden border-b" style={{ borderColor: SOL.base2 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-16 sm:pt-24 pb-20 sm:pb-36 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] gap-14 lg:gap-14 items-center">
        <div>
          <Link href="/features" className="pb-anim pb-rise inline-flex items-center gap-2 font-mono text-[13px]" style={{ color: CYAN }}>
            <span aria-hidden>←</span> Features <span style={{ color: SOL.base1 }}>/</span> <span style={{ color: SOL.base01 }}>cast publish</span>
          </Link>
          <h1
            className="pb-anim pb-rise mt-6 font-mono font-bold text-[34px] sm:text-[44px] xl:text-[48px] leading-[1.06] tracking-[-0.045em] [text-wrap:balance]"
            style={delay(0.08, { color: SOL.base03 })}
          >
            Your agent&apos;s work, at a link that stays current.
          </h1>
          <p className="pb-anim pb-rise mt-6 text-[18px] sm:text-[19px] leading-8 max-w-xl" style={delay(0.16, { color: SOL.base01 })}>
            <code className="font-mono text-[0.9em]" style={{ color: SOL.base02 }}>cast publish</code> turns an HTML file, a markdown file or a
            folder into a page at <span className="font-mono text-[0.9em] whitespace-nowrap" style={{ color: SOL.base02 }}>codecast.sh/a/&lt;slug&gt;</span>.
            Publish the same file again and the same link shows the new version. Old versions stay viewable, diffable and restorable,
            and readers can comment straight back into the session that made the page.
          </p>
          <div className="pb-anim pb-rise mt-8 flex flex-wrap items-center gap-x-6 gap-y-4" style={delay(0.24)}>
            <CopyCommand />
            <a href="#reference" className="font-mono text-[13px] underline underline-offset-4 decoration-1" style={{ color: SOL.base01, textDecorationColor: "rgba(42,161,152,.6)" }}>
              Every flag and subcommand
            </a>
          </div>
        </div>

        <div className="relative">
          <div className="relative h-[330px] sm:h-[360px] mr-6 sm:mr-8">
            <Sheet v={1} offset={28} d={1.25} />
            <Sheet v={2} offset={14} d={2.15} />
            <Sheet v={3} offset={0} d={3.15} front />
            <CommentPopover />
          </div>
          <div className="relative z-20 mt-10 lg:mt-0 lg:absolute lg:-left-10 lg:-bottom-32 lg:w-[60%]">
            <WatchTerminal />
          </div>
        </div>
      </div>
    </header>
  );
}
