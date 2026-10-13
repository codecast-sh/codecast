"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, CYAN, Note, Section } from "./kit";

const CHAPTERS = [
  { title: "Setup", dur: 40.6 },
  { title: "The failing run", dur: 72.2 },
  { title: "The fix", dur: 55.0 },
  { title: "Verified", dur: 31.4 },
];
const TOTAL = CHAPTERS.reduce((s, c) => s + c.dur, 0);

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** A faithful sketch of the cast player: a frame, a segmented timeline, a chapter menu. */
function Player() {
  const [chapter, setChapter] = useState(1);
  const start = CHAPTERS.slice(0, chapter).reduce((s, c) => s + c.dur, 0);
  const at = start + CHAPTERS[chapter].dur * 0.4;
  return (
    <div className="rounded-xl overflow-hidden" style={{ backgroundColor: SOL.base03, boxShadow: "0 30px 60px -30px rgba(0,43,54,.6)" }}>
      <div className="relative aspect-video">
        <div className="absolute inset-0" style={{ background: `radial-gradient(120% 90% at 30% 20%, rgba(42,161,152,.28), transparent 60%), radial-gradient(90% 70% at 85% 90%, rgba(38,139,210,.2), transparent 60%)` }} />
        <div className="absolute left-[8%] top-[14%] right-[30%] bottom-[22%] rounded-md border" style={{ borderColor: "rgba(147,161,161,.25)", backgroundColor: "rgba(0,43,54,.55)" }}>
          <div className="px-3 py-2 font-mono text-[10px] sm:text-[11px] leading-[1.7]" style={{ color: SOL.base0 }}>
            <div><span style={{ color: SOL.green }}>$</span> bun test checkout.test.ts</div>
            {chapter >= 2
              ? <div style={{ color: SOL.green }}>✓ 14 pass  0 fail</div>
              : <div style={{ color: SOL.red }}>✗ applies the coupon once</div>}
          </div>
        </div>
        <div key={chapter} className="pb-anim pb-rise absolute left-4 bottom-4 font-mono text-[12px] sm:text-[13px] font-semibold rounded px-2 py-1" style={{ color: SOL.base3, backgroundColor: "rgba(0,43,54,.7)" }}>
          {chapter + 1}. {CHAPTERS[chapter].title}
        </div>
        <div className="absolute right-4 top-4 rounded-md overflow-hidden text-[11px] font-mono border hidden sm:block" style={{ borderColor: "rgba(147,161,161,.25)", backgroundColor: "rgba(7,54,66,.92)" }}>
          {CHAPTERS.map((c, i) => (
            <button key={c.title} type="button" onClick={() => setChapter(i)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors" style={{ color: i === chapter ? SOL.base3 : SOL.base0, backgroundColor: i === chapter ? "rgba(42,161,152,.35)" : undefined }}>
              <span className="w-3 opacity-60">{i + 1}</span>
              <span className="flex-1">{c.title}</span>
              <span className="opacity-60">{fmt(c.dur)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="px-4 pt-3 pb-4">
        <div className="flex gap-[3px] h-1.5" role="group" aria-label="Chapters">
          {CHAPTERS.map((c, i) => {
            const fill = i < chapter ? 1 : i === chapter ? 0.4 : 0;
            return (
              <button key={c.title} type="button" onClick={() => setChapter(i)} aria-label={`Chapter ${i + 1}: ${c.title}`} className="relative h-full rounded-full overflow-hidden" style={{ flexGrow: c.dur, flexBasis: 0, backgroundColor: "rgba(147,161,161,.25)" }}>
                <span className="absolute inset-y-0 left-0 transition-[width] duration-300" style={{ width: `${fill * 100}%`, backgroundColor: CYAN }} />
              </button>
            );
          })}
        </div>
        <div className="mt-2.5 flex items-center gap-3 font-mono text-[11px]" style={{ color: SOL.base0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill={SOL.base2} aria-hidden><path d="M7 4v16l13-8z" /></svg>
          <span>{fmt(at)} / {fmt(TOTAL)}</span>
          <span className="ml-auto truncate" style={{ color: SOL.base01 }}>#chapter={chapter + 1}</span>
        </div>
      </div>
    </div>
  );
}

const SNIPPET = `<cast-player title="Fixing the coupon bug">
  <cast-chapter src="c01.mp4" title="Setup" duration="40.6">
  <cast-chapter src="c02.mp4" title="The failing run" duration="72.2">
  <cast-chapter src="c03.mp4" title="The fix" duration="55.0">
  <cast-chapter src="c04.mp4" title="Verified" duration="31.4">
</cast-player>`;

export function Video() {
  return (
    <Section
      id="video"
      n="07"
      tone="sand"
      title="Put a screen recording in the bundle. It plays like a film."
      lede={<>Video and audio inside a published folder upload to media hosting and keep their relative paths, so <C>&lt;video src=&quot;demo.mp4&quot;&gt;</C> just works. A video with controls becomes the cast player, and several clips can play back to back as chapters of one film.</>}
    >
      <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] gap-10 items-start">
        <div className="min-w-0">
          <Player />
          <p className="mt-3 font-mono text-[11.5px]" style={{ color: SOL.base1 }}>Click a chapter. Links open at a time with <span style={{ color: CYAN }}>#t=1:30</span> or at a chapter with <span style={{ color: CYAN }}>#chapter=3</span>.</p>
          <pre className="mt-6 rounded-xl p-4 font-mono text-[11.5px] leading-[1.75] overflow-x-auto" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
            {SNIPPET.split("\n").map((l, i) => (
              <span key={i} className="block">
                {l.replace(/(<\/?[a-z-]+)|([a-z]+=)|("[^"]*")/g, "\u0000$&\u0000").split("\u0000").map((part, k) => {
                  const color = part.startsWith("<") ? SOL.blue : part.endsWith("=") ? SOL.yellow : part.startsWith('"') ? SOL.cyan : undefined;
                  return <span key={k} style={{ color }}>{part}</span>;
                })}
              </span>
            ))}
          </pre>
        </div>
        <div className="min-w-0">
          <div className="space-y-4">
            <Note>
              Files up to 2 GB each, in <C>.mp4</C>, <C>.webm</C>, <C>.mov</C>, <C>.m4v</C>, <C>.mp3</C>, <C>.m4a</C>, <C>.ogg</C> and <C>.wav</C>. They don&apos;t count toward the page&apos;s 8 MB, and a <C>--watch</C> loop doesn&apos;t upload an unchanged file twice.
            </Note>
            <Note>
              Style the player from the page&apos;s CSS with <C>--cast-accent</C>, <C>--cast-font</C>, <C>--cast-aspect</C> and friends. Script it with <C>play()</C>, <C>seek()</C> and <C>goTo()</C>. Add <C>data-native</C> to keep the browser&apos;s own player; autoplay and looping clips stay native on their own.
            </Note>
            <Note>
              <C>cast publish video</C> prints the full guide.
            </Note>
          </div>
        </div>
      </div>
    </Section>
  );
}
