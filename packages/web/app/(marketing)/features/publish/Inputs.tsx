"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, CYAN, Caption, Section } from "./kit";

type Row = { file: ReactNode; kind: string; rules: ReactNode[] };

const TREE: { path: string; depth: number; note?: string; tone?: "skip" | "media" | "entry" }[] = [
  { path: "launch-review/", depth: 0 },
  { path: "index.html", depth: 1, note: "entry page", tone: "entry" },
  { path: "styles.css", depth: 1 },
  { path: "charts/funnel.svg", depth: 1 },
  { path: "walkthrough.mp4", depth: 1, note: "media hosting", tone: "media" },
  { path: ".env", depth: 1, note: "skipped", tone: "skip" },
  { path: "node_modules/", depth: 1, note: "skipped", tone: "skip" },
  { path: "app.js.map", depth: 1, note: "skipped", tone: "skip" },
];

function BundleTree() {
  return (
    <div className="rounded-lg font-mono text-[12px] leading-[1.9] px-4 py-3" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
      {TREE.map((t) => {
        const skip = t.tone === "skip";
        const color = t.tone === "entry" ? CYAN : t.tone === "media" ? SOL.violet : skip ? SOL.base01 : SOL.base1;
        return (
          <div key={t.path} className="flex items-center gap-3" style={{ paddingLeft: t.depth * 16 }}>
            <span style={{ color, textDecoration: skip ? "line-through" : undefined, textDecorationColor: "rgba(220,50,47,.6)" }}>{t.path}</span>
            {t.note && (
              <span className="ml-auto text-[10.5px]" style={{ color: skip ? "rgba(220,50,47,.75)" : color }}>{t.note}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A thumbnail of the page a single file becomes: a dashboard for html, a reading page for markdown. */
function MiniPage({ kind }: { kind: "html" | "markdown" }) {
  const line = (w: string, c: string = SOL.base2) => <div className="h-[5px] rounded-full" style={{ width: w, backgroundColor: c }} />;
  return (
    <div className="mt-4 w-[220px] rounded-md border overflow-hidden bg-white" style={{ borderColor: "rgba(88,110,117,.22)" }} aria-hidden>
      <div className="h-[14px] border-b flex items-center gap-1 px-1.5" style={{ borderColor: SOL.base2, backgroundColor: SOL.base3 }}>
        <span className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: CYAN, opacity: 0.6 }} />
        <span className="h-[3px] w-12 rounded-full" style={{ backgroundColor: SOL.base2 }} />
      </div>
      {kind === "html" ? (
        <div className="p-2.5 grid grid-cols-[1fr_70px] gap-2.5 items-end">
          <div className="space-y-1.5">{line("70%", "rgba(0,43,54,.55)")}{line("100%")}{line("85%")}{line("60%")}</div>
          <svg width="70" height="40" viewBox="0 0 70 40">
            {[34, 26, 18, 30, 12].map((h, i) => <rect key={i} x={i * 14 + 1} y={40 - h} width="10" height={h} rx="1.5" fill={i === 3 ? CYAN : "rgba(42,161,152,.3)"} />)}
          </svg>
        </div>
      ) : (
        <div className="px-6 py-2.5 space-y-1.5">{line("55%", "rgba(0,43,54,.55)")}{line("100%")}{line("94%")}{line("88%")}{line("40%", "rgba(0,43,54,.35)")}{line("97%")}</div>
      )}
    </div>
  );
}

function FileToken({ name, glyph, kind }: { name: string; glyph: string; kind: "html" | "markdown" }) {
  return (
    <div>
    <div className="inline-flex items-center gap-2.5">
      <span className="relative inline-flex h-11 w-9 items-end justify-center rounded-[3px] pb-1 font-mono text-[8.5px] font-bold" style={{ backgroundColor: "#fff", border: "1px solid rgba(88,110,117,.3)", color: CYAN, clipPath: "polygon(0 0, 70% 0, 100% 22%, 100% 100%, 0 100%)" }}>
        {glyph}
      </span>
      <span className="font-mono text-[15px] font-semibold" style={{ color: SOL.base03 }}>{name}</span>
    </div>
    <MiniPage kind={kind} />
    </div>
  );
}

const ROWS: Row[] = [
  {
    file: <FileToken name="report.html" glyph="HTML" kind="html" />,
    kind: "html",
    rules: [
      <>Ships exactly as written. Scripts run, charts draw, forms work.</>,
      <>The title comes from the <C>&lt;title&gt;</C> tag, else the filename.</>,
      <>The page runs in a browser sandbox with no access to your codecast sign-in, so a script on it can&apos;t act as you.</>,
    ],
  },
  {
    file: <FileToken name="findings.md" glyph="MD" kind="markdown" />,
    kind: "markdown",
    rules: [
      <>Renders as a clean reading page. Nobody has to write HTML for a write-up.</>,
      <>The title comes from the first heading.</>,
      <>Diffs between versions compare the markdown source, so a changed sentence reads as one changed line.</>,
    ],
  },
  {
    file: <BundleTree />,
    kind: "bundle",
    rules: [
      <><C>index.html</C> is the entry, or the folder&apos;s only <C>.html</C> file. Relative paths keep working.</>,
      <>Dotfiles, <C>node_modules</C> and sourcemaps stay behind.</>,
      <>Up to 8 MB of files. Video and audio upload to media hosting instead, up to 2 GB each, and don&apos;t count toward that.</>,
    ],
  },
];

export function Inputs() {
  return (
    <Section
      id="inputs"
      n="05"
      tone="sand"
      title="Three kinds of input, one kind of link."
      lede={<>The agent publishes whatever it already wrote. A file or folder is the page&apos;s identity: when the agent publishes the same one again, the same page updates.</>}
    >
      <div className="divide-y rounded-2xl border bg-white/60" style={{ borderColor: "rgba(88,110,117,.2)" }}>
        {ROWS.map((r) => (
          <div key={r.kind} className="grid md:grid-cols-[minmax(0,330px)_40px_minmax(0,1fr)] gap-6 md:gap-4 items-center p-6 sm:p-8" style={{ borderColor: "rgba(88,110,117,.15)" }}>
            <div className="min-w-0">{r.file}</div>
            <div className="hidden md:flex items-center justify-center" aria-hidden>
              <svg width="34" height="14" viewBox="0 0 34 14"><path d="M0 7h30m-6-6 6 6-6 6" fill="none" stroke={CYAN} strokeWidth="1.6" /></svg>
            </div>
            <div>
              <div className="font-mono text-[12px] font-semibold mb-3" style={{ color: CYAN }}>kind: {r.kind}</div>
              <ul className="space-y-2.5">
                {r.rules.map((rule, i) => (
                  <li key={i} className="flex gap-3 text-[15px] leading-7" style={{ color: SOL.base01 }}>
                    <span className="mt-[13px] h-[5px] w-[5px] rounded-full shrink-0" style={{ backgroundColor: "rgba(42,161,152,.55)" }} />
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 grid md:grid-cols-3 gap-x-8 gap-y-1">
        <Caption><C>--title</C> overrides the title; <C>--title -</C> reads it from stdin.</Caption>
        <Caption>On first publish, a local headless Chrome captures a 1200×630 thumbnail. <C>--no-thumb</C> skips it.</Caption>
        <Caption>An image file is refused with a pointer to <C>cast image</C>, which is built for single pictures.</Caption>
      </div>
    </Section>
  );
}
