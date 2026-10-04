"use client";

import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { featureHref, featureDeepDives } from "../catalog";
import { HeroStage } from "./HeroStage";
import { ReadingDemo } from "./Reading";
import { BatchDemo, ErrorList, Guardrails, OutcomesDemo, Reference, RoutesTable, SetupPanel, StepWords, TwoCursors } from "./Sections";
import { AgentCursorGlyph, C, Section, useStillMode } from "./parts";
import "./computer.css";
import { CopyCommand } from "../kit";

/**
 * /features/computer. The page reads like the tree cast computer prints: each
 * section heading is an indexed element (the indexes are sparse, as real ones
 * are), and the hero is a Mac desktop where an agent works in a background
 * window while the human keeps typing in front.
 */
export default function ComputerPage() {
  const still = useStillMode();
  return (
    <main className={`relative ${still ? "cx-still" : ""}`} style={{ backgroundColor: SOL.base3, color: SOL.base03 }}>
      <Hero />
      <UseCases />

      <Section
        id="read"
        index={3}
        role="split group"
        tone="paper"
        title="One window, read as an indexed tree."
        lede={<>An agent names an app and gets back one window as text: every element on its own line, with an index, a role, a name and the actions it advertises. This is a real Finder tree, with the file names changed.</>}
      >
        <ReadingDemo>
          <p><b style={{ color: SOL.base02 }}>Cheap to narrow.</b> <C>find &quot;Sign&quot;</C> prints only the matches and their ancestors. <C>--under 31</C> prints one subtree. Both take a <C>/regex/</C>.</p>
          <p><b style={{ color: SOL.base02 }}>Sparse on purpose.</b> The tree drops noise, so indexes skip. An agent never counts its way to one; it reads the number off the line.</p>
          <p><b style={{ color: SOL.base02 }}>Stale by design.</b> An index belongs to the tree it came from. A stale one fails as <C>element_not_found</C> instead of clicking whatever sits there now.</p>
        </ReadingDemo>
      </Section>

      <Section
        id="changes"
        index={7}
        role="tab group"
        title="Every action says what it changed."
        lede={<>An action prints one sentence saying what was attempted, by which route and whether it was verified, then the lines of the tree that moved. The agent gets the indexes for its next step without taking another snapshot, and finds out right away when an app ignored it.</>}
      >
        <OutcomesDemo />
      </Section>

      <Section
        id="screen"
        index={12}
        role="group"
        tone="paper"
        title="You keep your screen, your mouse and your keyboard."
        lede={<>Every verb works on a background window. The agent&apos;s keys go to the app it is driving, never to the one you are typing in. No verb brings a window forward on its own.</>}
      >
        <div className="grid-cols-1 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center">
          <TwoCursors still={still} />
          <div className="space-y-4 text-[16px] leading-[1.7]" style={{ color: SOL.base00 }}>
            <div className="text-[17px] leading-none"><AgentCursorGlyph size={1} /></div>
            <p>
              <b style={{ color: SOL.base02 }}>The orange pointer is the agent.</b> Any action that lands on a point draws it gliding there and pulsing on the press, over the screen and without taking focus, so you can see what is happening without being interrupted. <C>--no-cursor</C> hides it for one action.
            </p>
            <p>
              When an action does need a real mouse event, your pointer returns to where it was. The one flag that raises the target window is <C>--restore-window</C>, and agents are told to pass it only when nothing else will do.
            </p>
          </div>
        </div>
        <div className="mt-12">
          <RoutesTable />
        </div>
      </Section>

      <Section
        id="batch"
        index={18}
        role="list"
        title="Many steps, one process."
        lede={<>Each separate command pays a second or more to start the CLI. <C>cast computer do</C> runs a whole flow against one app over one helper connection. It stops at the first failing step and reports what ran and what never did; <C>--keep-going</C> carries on.</>}
      >
        <BatchDemo />
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-start">
          <p className="text-[15px] leading-relaxed" style={{ color: SOL.base00 }}>
            Steps read the way the window does, and each takes the single command&apos;s flags. A bare <C>click</C> or <C>action</C> after a <C>find</C> acts on what it found.
          </p>
          <StepWords />
        </div>
      </Section>

      <Section
        id="safety"
        index={23}
        role="group"
        tone="dark"
        title="Built for a machine with your life on it."
        lede={<>Your Mac holds your mail, your bank and your passwords. These limits are enforced where they cannot be talked around, or written into the instructions every agent reads.</>}
      >
        <Guardrails />
      </Section>

      <Section
        id="errors"
        index={29}
        role="outline"
        title="Every failure names its way out."
        lede={<>A failure carries a code and the recovery for it: in <C>--json</C> as <C>code</C> and <C>recovery</C>, printed under the message otherwise. The rule they share: change something before retrying, never rerun unchanged. These are the recoveries word for word.</>}
      >
        <ErrorList />
      </Section>

      <Section
        id="setup"
        index={34}
        role="sheet"
        tone="paper"
        title="Two grants, once, to a helper that holds nothing else."
        lede={<>macOS asks a person to grant Accessibility and Screen Recording by hand. Until then every verb fails and says so. Codecast signs a small helper app and asks for both on its behalf, so your terminal never needs them.</>}
      >
        <SetupPanel />
      </Section>

      <Section
        id="reference"
        index={40}
        role="table"
        tone="dark"
        wide
        title="Command reference."
        lede={<>From <C>cast computer --help</C>. <C>cast computer help &lt;verb&gt;</C> prints one verb&apos;s flags from the binary about to run them, so an agent never works from a stale list.</>}
      >
        <Reference />
      </Section>

      <Limits />
      <Closing />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(900px 500px at 85% 0%, color-mix(in srgb, ${SOL.magenta} 9%, transparent), transparent 70%), radial-gradient(700px 500px at 0% 30%, color-mix(in srgb, ${SOL.cyan} 8%, transparent), transparent 70%)` }} />
      <div className="relative max-w-7xl mx-auto px-5 sm:px-8 pt-12 sm:pt-16 pb-16 sm:pb-24">
        <div className="grid-cols-1 grid gap-8 lg:gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] items-end">
          <h1 className="cx-in font-mono font-bold tracking-[-0.035em] text-[36px] sm:text-[54px] xl:text-[60px] leading-[1.03] [text-wrap:balance]" style={{ color: SOL.base03 }}>
            <span className="block">Your agent uses the apps on your&nbsp;Mac.</span>
            <span className="block mt-2" style={{ color: SOL.base01 }}>You keep&nbsp;typing.</span>
          </h1>
          <div>
            <p className="cx-in text-[17px] sm:text-[18px] leading-[1.65]" style={{ color: SOL.base00, animationDelay: "120ms" }}>
              <span className="font-mono" style={{ color: SOL.magenta }}>cast computer</span> reads a native window as an indexed accessibility tree, acts on it by name, and reports exactly what changed. It works on windows behind the one you are using, so Preview, Slack, System Settings or your own desktop build are in reach without the agent taking your screen.
            </p>
            <div className="cx-in mt-6 flex flex-wrap items-center gap-x-4 gap-y-3" style={{ animationDelay: "220ms" }}>
              <CopyCommand cmd="cast computer get-app-state --app com.apple.Preview" />
              <a href="#read" className="font-mono text-[13px] underline underline-offset-4" style={{ color: SOL.base01 }}>how it reads a window</a>
            </div>
          </div>
        </div>
        <div className="cx-in mt-10 sm:mt-12" style={{ animationDelay: "340ms" }}>
          <HeroStage />
        </div>
      </div>
    </section>
  );
}

const USES: { ask: string; does: string; verbs: string }[] = [
  { ask: "Sign the lease in Preview with my saved signature.", does: "Clicks Sign, picks the saved signature from the popover, and stops before saving or sending.", verbs: "find · click · action" },
  { ask: "Check that the desktop build shows the new settings pane.", does: "Reads your app's own window, opens the pane by name, and reports the tree and a screenshot.", verbs: "get-app-state · click · wait · shot" },
  { ask: "Pick the export folder in the save dialog.", does: "Works the native file picker and permission sheets a web page cannot reach.", verbs: "find · set-value · press-key" },
  { ask: "Is Bluetooth on, and which mic is selected?", does: "Reads System Settings and answers. Reading is the agent's to do; changing a setting waits for you to ask.", verbs: "find · get-app-state" },
];

function UseCases() {
  return (
    <section className="relative" style={{ backgroundColor: SOL.base03 }}>
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-16">
        <div className="flex items-baseline gap-3 font-mono">
          <span className="text-[12px]" style={{ color: SOL.base01 }}><span style={{ color: SOL.magenta }}>1</span> list</span>
          <h2 className="font-bold text-[20px] sm:text-[22px]" style={{ color: SOL.base2 }}>What you can hand it</h2>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-px rounded-2xl overflow-hidden md:grid-cols-2" style={{ backgroundColor: "#0b4a5a" }}>
          {USES.map((u) => (
            <div key={u.ask} className="p-6 sm:p-7" style={{ backgroundColor: SOL.base03 }}>
              <p className="text-[17px] leading-snug font-semibold" style={{ color: SOL.base3 }}>&ldquo;{u.ask}&rdquo;</p>
              <p className="mt-2 text-[15px] leading-relaxed" style={{ color: SOL.base1 }}>{u.does}</p>
              <p className="mt-3 font-mono text-[12px]" style={{ color: SOL.magenta }}>{u.verbs}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const LIMITS: { q: string; a: React.ReactNode }[] = [
  { q: "Which platforms?", a: <>macOS, and Linux under X11 through AT-SPI. Both need a desktop session with the app open. There is no Windows provider.</> },
  { q: "Does it open apps?", a: <>No. It drives windows that are already open. A closed app answers <C>window_not_found</C> with that said plainly.</> },
  { q: "What about apps that draw their own UI?", a: <>A canvas, a game or a drawing exposes little to accessibility, so the tree says little. Coordinate clicks and screenshots still work, and the CLI says when a change may sit outside what the tree shows.</> },
  { q: "Is “attempted” a failure?", a: <>No. It means the helper delivered the action but could not read back proof, which is normal for a press. The diff under it is the evidence; <C>verified</C> appears only when the change was read back.</> },
  { q: "When does it need my screen?", a: <>Only for a real mouse event: <C>--mouse</C>, <C>drag</C>, or a control with no accessibility press. macOS drops those on a background window, so the command fails with <C>window_not_focused</C> unless the agent passes <C>--restore-window</C>.</> },
  { q: "Is this for web pages too?", a: <>Use <Link href={featureHref("browser")} className="underline underline-offset-2">cast browser</Link> inside a page: it holds your logins and speaks the page&apos;s own structure. <C>cast computer</C> is for native apps and for what a page cannot reach, such as the address bar, a file picker or a permission sheet.</> },
];

function Limits() {
  return (
    <section style={{ backgroundColor: SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <h2 className="font-mono font-bold tracking-[-0.03em] text-[28px] sm:text-[38px] leading-[1.1]" style={{ color: SOL.base03 }}>
          <span className="inline-block mr-3 align-[0.42em] text-[0.46em] font-normal tracking-normal" style={{ color: SOL.base1 }}><span style={{ color: SOL.magenta }}>47</span> group</span>
          Limits, plainly.
        </h2>
        <dl className="mt-12 grid grid-cols-1 gap-x-12 gap-y-9 md:grid-cols-2">
          {LIMITS.map((l) => (
            <div key={l.q}>
              <dt className="font-mono font-bold text-[16px]" style={{ color: SOL.base02 }}>{l.q}</dt>
              <dd className="mt-2 text-[15.5px] leading-[1.7]" style={{ color: SOL.base00 }}>{l.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const RELATED = ["browser", "cloud", "agents", "decisions"];

function Closing() {
  const related = featureDeepDives(RELATED);
  return (
    <section style={{ backgroundColor: "#f6efda" }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24">
        <div className="font-mono text-[13px]" style={{ color: SOL.base1 }}>Related</div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {related.map((f) => (
            <Link key={f.slug} href={featureHref(f.slug)} className="group rounded-xl p-4 border transition-colors hover:bg-[#fdf6e3]" style={{ borderColor: SOL.base2 }}>
              <span className="flex items-center gap-2 font-mono text-[14px] font-bold" style={{ color: SOL.base02 }}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f.color }} />
                {f.name}
                <span className="ml-auto transition-transform group-hover:translate-x-0.5" style={{ color: SOL.base1 }}>→</span>
              </span>
              <span className="mt-1.5 block text-[13.5px] leading-snug" style={{ color: SOL.base00 }}>{f.dek}</span>
            </Link>
          ))}
        </div>

        <div className="mt-20 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center">
          <div>
            <h2 className="font-mono font-bold tracking-[-0.03em] text-[30px] sm:text-[40px] leading-[1.08]" style={{ color: SOL.base03 }}>
              Install codecast. Grant two permissions. Hand it a window.
            </h2>
            <p className="mt-4 text-[16px] leading-[1.7] max-w-lg" style={{ color: SOL.base00 }}>
              Every agent you run through codecast learns <C>cast computer</C> from its instructions. Run <C>cast computer setup</C> once, then ask for the thing you would otherwise click through yourself.
            </p>
          </div>
          <InstallTabs location="feature_computer" />
        </div>
      </div>
    </section>
  );
}
