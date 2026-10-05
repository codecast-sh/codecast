"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Layer, Pane, Run, C, t, Note, VIOLET } from "./kit";

/**
 * Layer 02: `cast read <id> --ask`. A session drawn as a core of 214
 * messages, with the lines the answer rests on lit up, above the answer in
 * the CLI's own format.
 */

const TOTAL = 214;
// The excerpt picker's matches: a scatter the model was shown, then the cited lines.
const MATCHED = [4, 11, 19, 31, 40, 52, 61, 70, 77, 84, 86, 87, 88, 89, 90, 95, 101, 112, 118, 126, 131, 136, 138, 139, 140, 141, 142, 150, 163, 171, 180, 188, 196, 203, 209];
const CITED = new Map<number, "first" | "final">([[88, "first"], [139, "final"], [140, "final"], [141, "final"]]);

function Core() {
  return (
    <div className="mb-5" aria-hidden>
      <div className="flex items-center justify-between font-mono text-[11px] mb-1.5" style={{ color: SOL.base1 }}>
        <span>msg 1</span>
        <span className="hidden sm:inline">jx7k2qa · Retry cap for failed webhooks</span>
        <span>msg {TOTAL}</span>
      </div>
      <div className="relative h-11 rounded-md overflow-hidden" style={{ backgroundColor: SOL.base2 }}>
        {MATCHED.map((m) => {
          const c = CITED.get(m);
          const color = c === "final" ? SOL.orange : c === "first" ? VIOLET : `color-mix(in srgb, ${SOL.base01} 35%, transparent)`;
          return (
            <span
              key={m}
              className={c ? "mm-anim mm-open absolute top-0 bottom-0" : "absolute top-2 bottom-2"}
              style={{ left: `${((m - 1) / TOTAL) * 100}%`, width: c ? 3 : 1.5, backgroundColor: color, "--d": c === "first" ? ".3s" : ".55s" } as CSSProperties}
            />
          );
        })}
        <span className="absolute font-mono text-[10.5px] px-1.5 rounded" style={{ left: `calc(${(87 / TOTAL) * 100}% - 46px)`, top: 2, color: SOL.base3, backgroundColor: VIOLET }}>msg 88</span>
        <span className="absolute font-mono text-[10.5px] px-1.5 rounded" style={{ left: `calc(${(141 / TOTAL) * 100}% + 6px)`, bottom: 2, color: SOL.base3, backgroundColor: SOL.orange }}>msg 139–141</span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 font-mono text-[11px]" style={{ color: SOL.base01 }}>
        <span><span className="inline-block w-2 h-2 mr-1.5 align-middle" style={{ backgroundColor: `color-mix(in srgb, ${SOL.base01} 35%, transparent)` }} />lines the model was shown</span>
        <span><span className="inline-block w-2 h-2 mr-1.5 align-middle" style={{ backgroundColor: VIOLET }} />first answer</span>
        <span><span className="inline-block w-2 h-2 mr-1.5 align-middle" style={{ backgroundColor: SOL.orange }} />the later line that replaced it</span>
      </div>
    </div>
  );
}

export function AskLayer() {
  return (
    <Layer
      n="02"
      id="ask"
      tint
      title={<>Ask a session a question. It cites its lines.</>}
      lede={
        <>
          <p>
            A long session is a lot to page through. <C>cast read &lt;id&gt; --ask</C> answers one question from that one session, leads with the direct answer, and backs each point with the messages it rests on, so you can open them with <C>cast read</C>.
          </p>
          <p>
            It reads forward past the first relevant passage. People change their minds and agents try things that fail, so when a later message revised the answer, you get the later one, with the earlier one named as history.
          </p>
          <Note label="this session">
            <C>cast read --ask &quot;what did the user ask for first?&quot;</C> with no id asks the session you are in, past its own compactions.
          </Note>
        </>
      }
    >
      <Core />
      <Pane label="cast read --ask" right="answered server side" wrap>
        <Run>cast read jx7k2qa --ask &quot;what retry cap did we settle on?&quot;</Run>
        {t.head(<>── Retry cap for failed webhooks<span className="hidden sm:inline"> ─────────────────</span></>)}{"\n"}
        {"   "}{t.id("jx7k2qa")} | 214 lines | {t.dim("what retry cap did we settle on?")}{"\n\n"}
        <span className="block max-w-[62ch]">{t.ink("Five attempts. The session first capped retries at 3 (msg 88), then raised the cap to 5 after a load test (msg 139–141).")}</span>{"\n"}
        <Bullet>msg 88: sam asks for 3, since Stripe already retries for three days and ours only has to cover our own outages.</Bullet>
        <Bullet>msg 139: the load test shows a deploy keeps the queue down for longer than three attempts cover.</Bullet>
        <Bullet>msg 141: MAX_ATTEMPTS becomes 5. The cap of 3 is history.</Bullet>{"\n"}
        {t.y("read:")} {t.v("cast read jx7k2qa 88")}  {t.v("cast read jx7k2qa 139:141")}{"\n"}
        {t.dim("claude-haiku-4-5 · read 214 lines, 35 matched, showed 214 · 41.2k in / 298 out, $0.043 · 8.9s")}
      </Pane>
      <div className="grid sm:grid-cols-2 gap-3 mt-5">
        <Note label="huge sessions">
          Too long to read whole, it reads the end first, then the start, and names the stretch it did not read, since that stretch could change the answer.
        </Note>
        <Note label="not found" color={SOL.cyan}>
          When the session does not hold the answer, it says so and points at the closest lines instead of guessing. <C>--json</C> returns the same as data.
        </Note>
      </div>
    </Layer>
  );
}

/** Layer 03: before starting work, `cast context`; across history, `cast ask`. */
export function ContextLayer() {
  return (
    <Layer
      n="03"
      id="context"
      title={<>Start from what the team already knows</>}
      lede={
        <>
          <p>
            Most rediscovery happens in the first ten minutes of a task, when an agent reads the code cold. <C>cast context</C> is the step before that: describe the work, name a file, or pass <C>--auto</C> to read your branch name and changed files, and it returns the sessions that already worked on it and the files they touched.
          </p>
          <p>
            <C>cast ask</C> goes the other way, from a question to the history. It expands the question into search terms, reads the top sessions (three by default, <C>-n</C> for more) and returns the passages that answer it, each with its session and message range.
          </p>
        </>
      }
    >
      <div className="space-y-4">
        <Pane label="before the first edit">
          <Run>cast context --auto   {t.dim("# on branch webhook-retry-jitter")}</Run>
          {t.dim('<CONTEXT query="webhook retry jitter">')}{"\n"}
          Found 3 relevant sessions{"\n\n"}
          {t.head("## Most Relevant")}{"\n"}
          [{t.id("jx7m41c")}] {t.g("○ done")} | 3d ago - &quot;Add jitter to webhook backoff&quot;{"\n"}
          {"  "}{t.dim("Files:")} src/webhooks/retry.ts, src/webhooks/retry.test.ts{"\n"}
          [{t.id("jx7k2qa")}] {t.g("○ done")} | 16d ago - &quot;Retry cap for failed webhooks&quot;{"\n"}
          {"  "}{t.dim("Files:")} src/webhooks/retry.ts, docs/webhooks.md{"\n\n"}
          {t.head("## Related Files")}{"\n"}
          - src/webhooks/retry.ts {t.dim("(3 sessions)")}{"\n"}
          - src/queue/worker.ts {t.dim("(2 sessions)")}{"\n"}
          {t.dim("</CONTEXT>")}
        </Pane>
        <Pane label="a question across sessions" wrap>
          <Run>cast ask &quot;why do we verify signatures before parsing?&quot;</Run>
          {t.dim('<ANSWER query="why do we verify signatures before parsing?">')}{"\n"}
          <span className="block max-w-[62ch]">{t.ink("Stripe signs the raw request body. Parsing and re-serializing the JSON changes the bytes, so the check has to run first.")}</span>{"\n"}
          Sources:{"\n"}
          - [{t.id("jx7f9de")}] msg 45-47: Stripe webhook ingest{"\n"}
          {t.dim("</ANSWER>")}
        </Pane>
      </div>
      <div className="grid sm:grid-cols-3 gap-3 mt-5 font-mono text-[12.5px]">
        <Mini cmd={`cast context "add refunds"`} d="by description" />
        <Mini cmd="cast context -f src/auth.ts" d="by a file" />
        <Mini cmd="cast context --auto" d="branch name and changed files" />
      </div>
    </Layer>
  );
}

/** A `- ` list line that wraps under its own text, the way a terminal reflows it. */
function Bullet({ children }: { children: ReactNode }) {
  return <span className="block max-w-[62ch] pl-[2ch] -indent-[2ch]">{t.ink(<>- {children}</>)}</span>;
}

function Mini({ cmd, d }: { cmd: string; d: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ backgroundColor: `color-mix(in srgb, ${VIOLET} 6%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${VIOLET} 18%, transparent)` }}>
      <div className="break-words" style={{ color: SOL.base02 }}>{cmd}</div>
      <div className="text-[11.5px] mt-0.5" style={{ color: SOL.base1 }}>{d}</div>
    </div>
  );
}
