"use client";

import type { CSSProperties } from "react";
import { SOL } from "../../blog/blogChrome";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { Layer, Pane, Run, C, t, Note, VIOLET } from "./kit";

const FULL_ID = "jx7k2qa8m3v0d1y6h4t9rbc2wqe5fn7s";

/**
 * Layer 04: `cast blame` and the trailer that makes it exact. The commit is
 * drawn as the seam between git and the session record: the trailer is the
 * one line that belongs to both.
 */
export function BlameLayer() {
  return (
    <Layer
      n="04"
      id="blame"
      tint
      wide
      title={<>git blame, with the session in the author column</>}
      lede={
        <>
          <p>
            When agents write the code, <C>git blame</C> names whoever committed it, which tells you nothing about why. <C>cast blame</C> is a drop-in replacement: same output, but the author column shows the session that wrote each line, with its id and title.
          </p>
          <p>
            The output matches git blame&apos;s default and porcelain formats, so an editor integration that shells out to <C>git blame</C> can call <C>cast blame</C> instead. Lines no session wrote keep their git author.
          </p>
        </>
      }
    >
      <Pane label="~/src/payments">
        <Run>cast blame -L 3,8 src/webhooks/retry.ts</Run>
        {t.dim("a91f03e2c")} ({t.v("jx7f9de lee  Stripe webhook ingest        ")} {t.dim("2026-08-30 11:20:04 -0400")} 3) {t.ink('import { queue } from "../queue";')}{"\n"}
        {t.dim("a91f03e2c")} ({t.v("jx7f9de lee  Stripe webhook ingest        ")} {t.dim("2026-08-30 11:20:04 -0400")} 4) {t.ink('import type { WebhookEvent } from "./types";')}{"\n"}
        <span style={{ backgroundColor: "rgba(108,113,196,.22)" }}>{t.dim("4b1c9e2a1")} ({t.v("jx7k2qa sam  Retry cap for failed webhooks")} {t.dim("2026-09-18 14:02:11 -0400")} 5) {t.ink("export const MAX_ATTEMPTS = 5;")}</span>{"\n"}
        {t.dim("4b1c9e2a1")} ({t.v("jx7k2qa sam  Retry cap for failed webhooks")} {t.dim("2026-09-18 14:02:11 -0400")} 6) {t.ink("export const BASE_DELAY_MS = 2_000;")}{"\n"}
        {t.dim("c07d5b1f8")} ({t.v("jx7m41c maya Add jitter to webhook backoff")} {t.dim("2026-10-01 09:41:37 -0400")} 7) {t.ink("export function nextDelay(attempt: number) {")}{"\n"}
        {t.dim("e5520aa31")} ({"Dana Okafor                               "} {t.dim("2026-10-02 16:05:12 -0400")} 8) {t.ink("  const jitter = Math.random() * 0.3;")}
      </Pane>
      <p className="font-mono text-[11.5px] mt-2 mb-6" style={{ color: SOL.base1 }}>Line 8 was a hand edit, so it keeps its git author.</p>

      <Seam />
      <div className="grid md:grid-cols-3 gap-3 mt-4">
        <Note label="how">Codecast&apos;s hook in Claude Code adds the trailer to each <C>git commit</C> the agent runs. It never fails a commit.</Note>
        <Note label="who" color={SOL.cyan}>Only sessions your team can see get one, so a private session never leaks a link into a public history.</Note>
        <Note label="off" color={SOL.orange}><C>git config codecast.sessionTrailer false</C> in a repo, or <C>cast config session_trailer false</C>.</Note>
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-6">
        <Pane label="--porcelain adds codecast-* keys">
          {t.dim("4b1c9e2a1… 5 5 2")}{"\n"}
          {t.dim("author Sam Rivera")}{"\n"}
          {t.dim("summary Cap webhook retries at 5")}{"\n"}
          {t.v("codecast-session jx7k2qa")}{"\n"}
          {t.v("codecast-conversation jx7k2qa8m3v0d1y6h4t9rbc2wqe5fn7s")}{"\n"}
          {t.v("codecast-title Retry cap for failed webhooks")}{"\n"}
          {t.v("codecast-author sam")}{"\n"}
          {t.v("codecast-url https://codecast.sh/conversation/jx7k2qa…")}
        </Pane>
        <Pane label="--log: which sessions shaped a file">
          <Run>cast blame --log src/webhooks/retry.ts</Run>
          {t.dim("Sessions that shaped retry.ts (52/58 lines)")}{"\n\n"}
          {"  "}{t.id("jx7m41c")}  maya  {t.dim("c07d5b1f8")}  12 lines{"\n"}
          {"  "}{t.id("jx7k2qa")}  sam   {t.dim("4b1c9e2a1")}   9 lines{"\n"}
          {"  "}{t.id("jx7f9de")}  lee   {t.dim("a91f03e2c")}  31 lines
        </Pane>
      </div>

      <div className="mt-6 rounded-xl px-5 py-4" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
        <div className="font-mono text-[12.5px] font-semibold mb-3" style={{ color: SOL.base02 }}>In your editor</div>
        <ul className="space-y-2.5 text-[14px] leading-6" style={{ color: SOL.base01 }}>
          <li><C>cast blame --install-fugitive</C> installs a shim so vim-fugitive&apos;s <C>:Gblame</C> shows sessions.</li>
          <li><C>cast blame --log --quickfix</C> feeds a quickfix list: <KeyCap>Enter</KeyCap> opens the conversation, <KeyCap>O</KeyCap> opens the file at that session&apos;s commit.</li>
          <li><C>cast blame --open src/webhooks/retry.ts:5</C> resolves the line to its session and opens the conversation in your browser.</li>
        </ul>
      </div>
    </Layer>
  );
}

/** A commit drawn as the joint between git history and the session record. */
function Seam() {
  return (
    <div className="relative grid md:grid-cols-[minmax(0,3fr)_auto_minmax(0,2fr)] gap-3 md:gap-0 items-stretch">
      <div className="rounded-xl md:rounded-r-none px-4 py-3.5 font-mono text-[12px] leading-[1.7] overflow-x-auto" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
        <div style={{ color: SOL.yellow }}>commit 4b1c9e2a1</div>
        <div style={{ color: SOL.base01 }}>Author: Sam Rivera</div>
        <div className="mt-2 pl-4" style={{ color: SOL.base2 }}>Cap webhook retries at 5</div>
        <div className="mt-2 pl-4 break-all">
          <span className="mm-anim mm-glow rounded px-1 -mx-1" style={{ color: "#c9cbff", backgroundColor: "rgba(108,113,196,.14)", "--d": ".4s" } as CSSProperties}>
            Codecast-Session: https://codecast.sh/conversation/{FULL_ID}
          </span>
        </div>
      </div>
      <div aria-hidden className="hidden md:flex items-center">
        <span className="h-[3px] w-8" style={{ backgroundColor: VIOLET }} />
      </div>
      <div className="rounded-xl md:rounded-l-none px-4 py-3.5" style={{ backgroundColor: `color-mix(in srgb, ${VIOLET} 9%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${VIOLET} 28%, transparent)` }}>
        <div className="font-mono text-[12px] mb-1" style={{ color: VIOLET }}>jx7k2qa · claude · 214 msgs</div>
        <div className="font-mono text-[14px] font-semibold mb-2" style={{ color: SOL.base03 }}>Retry cap for failed webhooks</div>
        <div className="text-[13px] leading-[1.55]" style={{ color: SOL.base01 }}>
          The trailer names the session outright. A commit without one is matched by its hash, then by its subject and time.
        </div>
      </div>
    </div>
  );
}

/** Layer 05: `cast diff` and `cast summary`, the check before you attribute work. */
export function ImpactLayer() {
  return (
    <Layer
      n="05"
      id="impact"
      title={<>What a session actually changed</>}
      lede={
        <>
          <p>
            A session&apos;s state tells you who is paying attention to it now, not what it did. Before you credit a change to a session, or message it about its work, read the evidence.
          </p>
          <p>
            <C>cast diff</C> lists the files a session changed, the commits it made and the tools it used. <C>cast summary</C> gives its goal, approach, outcome and files. Both take <C>--today</C>, and <C>cast diff --week</C> rolls up the week.
          </p>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Pane label="cast diff">
          <Run>cast diff jx7k2qa</Run>
          {t.dim('<DIFF session="jx7k2qa" …>')}{"\n"}
          Duration: 2h 14m{"\n"}
          Messages: 214{"\n\n"}
          {t.head("## Files Changed (3)")}{"\n"}
          {t.y(" M")} src/webhooks/retry.ts       {t.g("+18")} {t.o("-4")}{"\n"}
          {t.y(" M")} src/webhooks/retry.test.ts  {t.g("+41")}{"\n"}
          {t.y(" M")} docs/webhooks.md            {t.g("+6")} {t.o("-2")}{"\n\n"}
          {t.head("## Commits (2)")}{"\n"}
          [{t.dim("4b1c9e2")}] Cap webhook retries at 5{"\n"}
          [{t.dim("19ad7c0")}] Load test for retry cap{"\n"}
          {t.dim("</DIFF>")}
        </Pane>
        <Pane label="cast summary">
          <Run>cast summary jx7k2qa</Run>
          {t.dim('<SUMMARY session="jx7k2qa">')}{"\n"}
          {t.head("# Retry cap for failed webhooks")}{"\n\n"}
          {t.head("## Goal")}{"\n"}
          Stop failed webhooks retrying forever.{"\n\n"}
          {t.head("## Outcome")}{"\n"}
          Cap of 5 attempts, backed by a{"\n"}load test.{"\n\n"}
          {t.head("## Files Changed")}{"\n"}
          - src/webhooks/retry.ts (+18 -4){"\n"}
          {t.dim("…")}
        </Pane>
      </div>
      <div className="mt-5">
        <Note label="--full · --patch">Add the full file diffs, or print only the unified patch to pipe somewhere else.</Note>
      </div>
    </Layer>
  );
}
