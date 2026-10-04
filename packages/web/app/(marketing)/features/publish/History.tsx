"use client";

import { useState } from "react";
import { SOL, Terminal } from "../../blog/blogChrome";
import { C, CYAN, Caption, Section } from "./kit";

const SLUG = "k3Vd9QpLm2Xa";

type Op = { t: "eq" | "add" | "del" | "fold"; a?: number; b?: number; line: string };

const DIFF: Op[] = [
  { t: "eq", a: 1, b: 1, line: "# Q3 churn audit" },
  { t: "eq", a: 2, b: 2, line: "" },
  { t: "del", a: 3, line: "Churn rose from 3.1% to 4.2% between July and September." },
  { t: "add", b: 3, line: "Churn rose from 3.1% to 4.4% between July and September." },
  { t: "eq", a: 4, b: 4, line: "Most of the increase sits in accounts under 90 days old." },
  { t: "fold", line: "⋯ 14 unchanged lines" },
  { t: "eq", a: 19, b: 19, line: "## By plan tier" },
  { t: "add", b: 20, line: "| Tier | Jul | Sep |" },
  { t: "add", b: 21, line: "| Solo | 3.8% | 5.1% |" },
  { t: "add", b: 22, line: "| Team | 2.2% | 2.6% |" },
];

const VERSIONS = [
  { v: 1, when: "2d", size: "6.1KB", note: "first draft" },
  { v: 2, when: "1d", size: "6.3KB", note: "fixed the September figure" },
  { v: 3, when: "3h", size: "7.9KB", note: "split by plan tier" },
  { v: 4, when: "now", size: "6.3KB", note: "rollback 2: v2's content, as a new version", rollback: true },
];

function DiffView() {
  return (
    <div className="rounded-xl border overflow-hidden bg-white" style={{ borderColor: "rgba(88,110,117,.25)" }}>
      <div className="flex items-center gap-3 px-4 h-10 border-b font-mono text-[11.5px]" style={{ borderColor: SOL.base2, backgroundColor: SOL.base3, color: SOL.base01 }}>
        <span className="font-semibold" style={{ color: SOL.base03 }}>Q3 churn audit</span>
        <span>v2 → v3</span>
        <span className="ml-auto" style={{ color: SOL.green }}>+4</span>
        <span style={{ color: SOL.red }}>−1</span>
      </div>
      <div className="font-mono text-[11.5px] leading-[1.75] overflow-x-auto">
        {DIFF.map((op, i) => {
          if (op.t === "fold") {
            return (
              <div key={i} className="px-4 py-1 text-[11px]" style={{ backgroundColor: "rgba(38,139,210,.06)", color: SOL.blue }}>{op.line}</div>
            );
          }
          const bg = op.t === "add" ? "rgba(133,153,0,.12)" : op.t === "del" ? "rgba(220,50,47,.09)" : undefined;
          const sign = op.t === "add" ? "+" : op.t === "del" ? "−" : " ";
          const signColor = op.t === "add" ? SOL.green : op.t === "del" ? SOL.red : SOL.base1;
          return (
            <div key={i} className="grid grid-cols-[28px_28px_16px_1fr] whitespace-pre" style={{ backgroundColor: bg }}>
              <span className="text-right pr-1.5 select-none" style={{ color: SOL.base1 }}>{op.a ?? ""}</span>
              <span className="text-right pr-1.5 select-none" style={{ color: SOL.base1 }}>{op.b ?? ""}</span>
              <span className="select-none" style={{ color: signColor }}>{sign}</span>
              <span className="pr-4" style={{ color: SOL.base02 }}>{op.line || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VersionRail() {
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="relative">
      <div className="absolute left-0 right-0 top-[22px] h-px" style={{ backgroundColor: "rgba(42,161,152,.35)" }} />
      <div className="relative grid grid-cols-4 gap-2">
        {VERSIONS.map((v) => {
          const current = v.v === 4;
          return (
            <button
              key={v.v}
              type="button"
              onMouseEnter={() => setHover(v.v)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(v.v)}
              onBlur={() => setHover(null)}
              className="text-left group"
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full border-2 font-mono text-[13px] font-bold transition-transform group-hover:-translate-y-0.5"
                style={{ borderColor: current ? CYAN : "rgba(42,161,152,.45)", backgroundColor: current ? CYAN : SOL.base3, color: current ? "#fff" : SOL.base02 }}
              >v{v.v}</span>
              <span className="mt-3 block font-mono text-[11px]" style={{ color: SOL.base1 }}>{v.when} · {v.size}</span>
              <span className="mt-1 block text-[13px] leading-5" style={{ color: hover === v.v || current ? SOL.base02 : SOL.base01 }}>{v.note}</span>
              <span className="mt-2 block font-mono text-[10.5px] transition-opacity" style={{ color: CYAN, opacity: hover === v.v ? 1 : 0.55 }}>?v={v.v}</span>
            </button>
          );
        })}
      </div>
      <svg className="absolute -top-7 left-[12.5%] w-[75%] h-7 overflow-visible" viewBox="0 0 300 28" preserveAspectRatio="none" aria-hidden>
        <path d="M100 26 C 160 -6, 250 -6, 296 24" fill="none" stroke={SOL.violet} strokeWidth="1.4" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export function History() {
  return (
    <Section
      id="history"
      n="03"
      title="Every version stays. Compare any two. Restore without losing one."
      lede={<>Each publish is a numbered version. The link always serves the newest, and every older one keeps its own address, a line-by-line diff against any other, and a one-command way back.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 lg:gap-12">
        <div className="min-w-0">
          <div className="pt-8">
            <VersionRail />
          </div>
          <div className="mt-10 [&>div]:my-0">
            <Terminal label="restore">
              <span style={{ color: SOL.green }}>$</span><span style={{ color: SOL.base1 }}> cast publish rollback {SLUG} 2</span>{"\n"}
              <span style={{ color: SOL.green }}>✓</span> Rolled back to v2 — now <span style={{ color: SOL.yellow }}>v4</span>{"\n\n"}
              <span style={{ color: SOL.green }}>$</span><span style={{ color: SOL.base1 }}> cast publish versions churn-audit.md</span>{"\n"}
              <span style={{ color: SOL.base2 }}>Q3 churn audit</span> <span style={{ color: SOL.base01 }}>({SLUG})</span>{"\n"}
              {VERSIONS.map((v) => (
                <span key={v.v} className="block">
                  {"  "}<span style={{ color: SOL.yellow }}>v{v.v}</span>  {v.when.padStart(4)}  {v.size.padStart(7)}
                  {v.v === 4 && <span style={{ color: SOL.green }}> ← current</span>}
                </span>
              ))}
              <span style={{ color: SOL.base01 }}>  restore: cast publish rollback {SLUG} &lt;n&gt;</span>{"\n"}
              <span style={{ color: SOL.base01 }}>  compare: https://{"codecast.sh/a/"}{SLUG}?diff=&lt;a&gt;..&lt;b&gt;</span>
            </Terminal>
          </div>
        </div>
        <div className="min-w-0">
          <DiffView />
          <Caption>
            <span className="font-semibold" style={{ color: SOL.base01 }}>…/{SLUG}?diff=2..3</span>. Markdown pages diff their markdown, so an edited sentence is one red line and one green line, not a wall of changed HTML. Long unchanged runs fold behind an expander.
          </Caption>
          <div className="mt-8 grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 font-mono text-[12.5px]">
            {[
              ["?v=3", "that version, as readers saw it"],
              ["?diff=2..3", "what changed between two versions"],
              ["?src=1", "the page's source"],
              ["?live=1", "reloads itself on each new version"],
            ].map(([q, d]) => (
              <div key={q} className="contents">
                <span className="font-semibold" style={{ color: CYAN }}>{q}</span>
                <span className="font-sans text-[14px]" style={{ color: SOL.base01 }}>{d}</span>
              </div>
            ))}
          </div>
          <p className="mt-8 text-[15px] leading-7" style={{ color: SOL.base01 }}>
            A rollback never rewrites history. It publishes the old content as the next version, so the version you rolled away from is still there if you
            change your mind. On the page, the version menu puts a diff link beside each older version, and the owner panel can roll back from the browser. To start a separate page from the same file, publish with <C>--new</C>.
          </p>
        </div>
      </div>
    </Section>
  );
}
