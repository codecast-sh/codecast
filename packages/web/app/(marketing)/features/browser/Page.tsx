"use client";

import Link from "next/link";
import { type CSSProperties } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { featureHref, featureDeepDives } from "../catalog";
import { HeroStage } from "./HeroStage";
import { BX_CSS, C, CAST_RED, GroupChip, INK } from "./kit";
import { DoSection, ElsewhereSection, EvidenceSection, LimitsSection, ReferenceSection, RefsSection, SafetySection, ScenariosSection, TabGroupSection, WheelSection } from "./Sections";

const STORE_URL = "https://chromewebstore.google.com/detail/codecast/odfpgkdaibmjhhnbndgbjlhdbciciifd";
const RELATED = ["computer", "publish", "cloud", "agents"];

const rise = (d: number): CSSProperties => ({ ["--d" as string]: `${d}s` });

export default function BrowserPage() {
  return (
    <main className="w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <style>{BX_CSS}</style>
      <Hero />
      <TabGroupSection />
      <EvidenceSection />
      <WheelSection />
      <ScenariosSection />
      <SafetySection />
      <ElsewhereSection />
      <RefsSection />
      <DoSection />
      <ReferenceSection />
      <LimitsSection />
      <Related />
      <Closing />
    </main>
  );
}

function Hero() {
  return (
    <section id="top" className="relative">
      {/* A faint red wash from the top right: the Cast group's color, kept quiet. */}
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(900px 420px at 85% 0%, rgba(220,50,47,.07), transparent 70%), radial-gradient(700px 380px at 0% 30%, rgba(38,139,210,.05), transparent 70%)" }} />
      <div className="relative max-w-7xl mx-auto px-5 sm:px-8 pt-12 sm:pt-16 pb-6 sm:pb-8">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-10 lg:gap-16 items-end [&>*]:min-w-0">
        <div className="max-w-3xl">
          <div className="bx-rise flex items-center gap-2.5 text-[13px] font-mono" style={{ ...rise(0), color: SOL.base01 }}>
            <GroupChip label="Cast" />
            <span>Browser</span>
          </div>
          <h1 className="bx-rise mt-5 font-mono font-bold text-[34px] sm:text-[46px] lg:text-[54px] leading-[1.06] tracking-[-0.04em] [text-wrap:balance]" style={{ ...rise(0.08), color: INK }}>
            Your agents get a tab in the Chrome you are already signed in to.
          </h1>
          <p className="bx-rise mt-6 text-[16px] sm:text-[17.5px] leading-8 max-w-2xl" style={{ ...rise(0.16), color: SOL.base01 }}>
            Each agent session drives its own background tab in your real Chrome, inside a red Cast tab group. It reads the page as numbered refs, acts on them, and posts every screenshot, console error and failed request into the conversation. You keep working in your own tabs.
          </p>
          <div className="bx-rise mt-8 flex flex-wrap items-center gap-x-5 gap-y-3" style={rise(0.24)}>
            <a
              href={STORE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center gap-2 rounded-lg px-4 text-[14px] font-semibold transition-all hover:-translate-y-px"
              style={{ backgroundColor: CAST_RED, color: "#fff", boxShadow: "0 8px 22px -10px rgba(220,50,47,.7)" }}
            >
              Add the extension
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path d="M7 17L17 7M9 7h8v8" /></svg>
            </a>
            <a href="#evidence" className="font-mono text-[13px] underline underline-offset-4" style={{ color: SOL.base01 }}>what you see in the thread</a>
          </div>
        </div>
        <div className="bx-rise" style={rise(0.3)}><SetupStrip /></div>
        </div>
        <div className="bx-rise mt-12 sm:mt-14" style={rise(0.36)}>
          <HeroStage />
        </div>
      </div>
    </section>
  );
}

/** One-time setup, as three beats: install, pair, connected. */
function SetupStrip() {
  const beats = [
    { k: "1", title: "Install the extension", body: <>From the Chrome Web Store, in the Chrome profile agents should use.</> },
    { k: "2", title: "Switch on Browser", body: <>In <b style={{ color: INK }}>Agent features</b>, turn on the Browser card and click <b style={{ color: INK }}>Pair</b>. Chrome opens the extension; click Pair there too.</> },
    { k: "3", title: "Done", body: <>The card reads <span className="font-mono text-[13px]" style={{ color: SOL.green }}>Chrome connected</span>. Every agent on the machine now uses your Chrome.</> },
  ];
  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid #eadfc2", backgroundColor: "rgba(255,250,240,.75)" }}>
      <div className="px-5 pt-4 pb-1 font-mono text-[12px]" style={{ color: SOL.base01 }}>Set up once, per machine</div>
      {beats.map((b, i) => (
        <div key={b.k} className="px-5 py-4" style={{ borderTop: i ? "1px solid #eee3c6" : undefined }}>
          <div className="flex items-center gap-2.5">
            <span className="h-6 w-6 rounded-full flex items-center justify-center font-mono text-[12px] font-bold text-white" style={{ backgroundColor: CAST_RED }}>{b.k}</span>
            <span className="font-mono font-bold text-[15px]" style={{ color: INK }}>{b.title}</span>
          </div>
          <p className="mt-2 text-[13.5px] leading-6 pl-[34px]" style={{ color: SOL.base01 }}>{b.body}</p>
        </div>
      ))}
      <div className="px-5 pb-5">
        <img
          src="/features/browser/agent-features-browser.webp"
          alt="The Browser card on the Agent features page: a Cast tab beside your own, the On badge and its switch, and the line Agents check their own UI work in your Chrome, with your sign-ins."
          width={856}
          height={575}
          loading="lazy"
          className="block w-full h-auto rounded-lg"
          style={{ border: "1px solid #eadfc2" }}
        />
        <p className="mt-2 font-mono text-[11.5px] leading-5" style={{ color: SOL.base01 }}>
          Scripting it? <C>cast browser extension setup</C> does the same pairing from a terminal.
        </p>
      </div>
    </div>
  );
}

function Related() {
  const items = featureDeepDives(RELATED);
  return (
    <section style={{ backgroundColor: SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20" style={{ borderTop: "1px solid #eee3c6" }}>
        <h2 className="font-mono font-bold text-[22px] sm:text-[26px] tracking-tight" style={{ color: INK }}>Works with</h2>
        <div className="mt-8 grid sm:grid-cols-2 gap-4">
          {items.map((f) => (
            <Link
              key={f.slug}
              href={featureHref(f.slug)}
              className="group block rounded-xl px-5 py-4 transition-all hover:-translate-y-0.5"
              style={{ backgroundColor: "#fffaf0", border: "1px solid #eee3c6", boxShadow: `inset 3px 0 0 ${f.color}` }}
            >
              <div className="font-mono font-semibold text-[15px] flex items-center gap-2" style={{ color: f.color }}>
                {f.name}
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </div>
              <p className="mt-1.5 text-[14px] leading-6" style={{ color: SOL.base01 }}>{f.dek}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section style={{ backgroundColor: SOL.base2 }}>
      <div className="max-w-3xl mx-auto px-5 sm:px-8 py-20 sm:py-24 text-center">
        <h2 className="font-mono font-bold text-[28px] sm:text-[38px] leading-[1.12] tracking-[-0.03em] [text-wrap:balance]" style={{ color: INK }}>
          Install codecast, add the extension, and your agents can see what your users see.
        </h2>
        <div className="mt-8 max-w-xl mx-auto text-left">
          <InstallTabs location="feature_browser" showAlternatives={false} />
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-[14px]">
          <a href={STORE_URL} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-lg px-4 font-semibold text-white" style={{ backgroundColor: CAST_RED }}>
            Codecast for Chrome
          </a>
          <span className="font-mono text-[13px]" style={{ color: SOL.base01 }}>then Pair it from Agent features</span>
        </div>
      </div>
    </section>
  );
}
