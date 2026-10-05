"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { FINDER_HEADER, FINDER_TREE } from "./data";
import { Lights } from "./parts";

/**
 * A Finder window beside the tree cast computer prints for it. Pointing at a
 * row lights the part of the window it names, and pointing at the window
 * lights its rows: the reader learns to read a tree by seeing both at once.
 */
export function ReadingDemo({ children }: { children?: ReactNode }) {
  const [hot, setHot] = useState<string | null>("docs");
  return (
    <div className="grid-cols-1 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] items-start">
      <div>
        <FinderMock hot={hot} setHot={setHot} />
        <p className="mt-3 font-mono text-[12px]" style={{ color: SOL.base1 }}>Point at the window or at a line of the tree.</p>
        <div className="mt-8 space-y-4 text-[15px] leading-relaxed" style={{ color: SOL.base00 }}>{children}</div>
      </div>
      <div className="rounded-xl overflow-hidden" style={{ backgroundColor: SOL.base03, border: "1px solid #094959" }}>
        <div className="px-4 py-2.5 font-mono text-[11px] truncate" style={{ backgroundColor: SOL.base02, color: SOL.base01, borderBottom: "1px solid #094959" }}>
          <span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base2 }}>cast computer get-app-state --app com.apple.finder --no-screenshot</span>
        </div>
        <div className="py-3 font-mono text-[11.5px] sm:text-[12px] leading-[1.7]">
          {FINDER_HEADER.map((l, i) => (
            <div key={i} className="px-4 whitespace-pre-wrap" style={{ color: i === 0 ? SOL.base1 : SOL.base01 }}>{l}</div>
          ))}
          <div className="h-3" />
          {FINDER_TREE.map((r, i) => {
            const on = !!r.k && hot === r.k;
            if (r.i === null) {
              return <div key={i} className="px-4 pt-2" style={{ color: SOL.base01 }}>{r.s}</div>;
            }
            return (
              <div
                key={i}
                className={`cx-row px-4 cursor-default ${on ? "is-hot" : ""}`}
                style={{ paddingLeft: `calc(1rem + ${r.d * 2}ch)`, color: on ? SOL.base3 : SOL.base0 }}
                onMouseEnter={() => r.k && setHot(r.k)}
              >
                <span style={{ color: on ? SOL.magenta : SOL.yellow }}>{r.i}</span> {r.s}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Region({ k, hot, setHot, className = "", style, children }: { k: string; hot: string | null; setHot: (k: string) => void; className?: string; style?: React.CSSProperties; children?: ReactNode }) {
  return (
    <div className={`cx-region rounded-md ${hot === k ? "is-hot" : ""} ${className}`} style={style} onMouseOver={(e) => { e.stopPropagation(); setHot(k); }}>
      {children}
    </div>
  );
}

function FinderMock({ hot, setHot }: { hot: string | null; setHot: (k: string) => void }) {
  const side: [string, string][] = [["recents", "Recents"], ["apps", "Applications"], ["docs", "Documents"], ["downloads", "Downloads"]];
  const files: [string, string, string, string][] = [
    ["f1", "Lease renewal.pdf", "PDF", "Today, 9:12"],
    ["f2", "Offsite agenda.key", "Keynote", "Yesterday"],
    ["f3", "Invoice 0931.pdf", "PDF", "Sep 30"],
  ];
  return (
    <div className="rounded-xl overflow-hidden font-sans text-[13px] select-none" style={{ backgroundColor: "#fbf8f0", boxShadow: "0 30px 70px -36px rgba(0,43,54,0.55), 0 0 0 1px rgba(0,43,54,0.12)" }}>
      <Region k="window" hot={hot} setHot={setHot} className="!rounded-xl">
        <Region k="toolbar" hot={hot} setHot={setHot} className="!rounded-none flex items-center gap-3 px-3.5 h-12" style={{ backgroundColor: "#f1ecdf", borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
          <Lights active />
          <Region k="back" hot={hot} setHot={setHot} className="ml-2 w-7 h-7 flex items-center justify-center" style={{ color: "#b9b2a2" }}>
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 3L5 8l5 5" /></svg>
          </Region>
          <span className="font-semibold" style={{ color: "#3b3a36" }}>Documents</span>
          <Region k="search" hot={hot} setHot={setHot} className="ml-auto flex items-center gap-1.5 px-2.5 h-7 w-[min(38%,150px)]" style={{ backgroundColor: "rgba(0,0,0,0.05)", color: "#9a9384" }}>
            <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
            <span className="truncate">Search</span>
          </Region>
        </Region>
        <div className="grid grid-cols-[38%_1fr] sm:grid-cols-[150px_1fr] min-h-[250px]">
          <Region k="sidebar" hot={hot} setHot={setHot} className="!rounded-none px-2 py-3 space-y-0.5" style={{ backgroundColor: "#efe9da" }}>
            <div className="px-2 pb-1 text-[11px] font-semibold" style={{ color: "#a59e8e" }}>Favorites</div>
            {side.map(([k, name]) => (
              <Region key={k} k={k} hot={hot} setHot={setHot} className="px-2 py-1 truncate" style={{ backgroundColor: k === "docs" ? "rgba(0,0,0,0.08)" : undefined, color: "#3b3a36" }}>
                {name}
              </Region>
            ))}
          </Region>
          <Region k="list" hot={hot} setHot={setHot} className="!rounded-none p-2">
            <div className="grid grid-cols-[1fr_auto] px-2 pb-1.5 text-[11px]" style={{ color: "#a59e8e", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
              <span>Name</span>
              <span className="hidden sm:block">Date modified</span>
            </div>
            {files.map(([k, name, kind, date]) => (
              <Region key={k} k={k} hot={hot} setHot={setHot} className="grid grid-cols-[1fr_auto] items-center gap-2 px-2 py-1.5 mt-0.5">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-3.5 h-4 rounded-[2px] shrink-0" style={{ backgroundColor: kind === "PDF" ? "#e86a5a" : "#4a90d9" }} />
                  <span className="truncate" style={{ color: "#3b3a36" }}>{name}</span>
                </span>
                <span className="hidden sm:block text-[12px]" style={{ color: "#9a9384" }}>{date}</span>
              </Region>
            ))}
          </Region>
        </div>
      </Region>
    </div>
  );
}
