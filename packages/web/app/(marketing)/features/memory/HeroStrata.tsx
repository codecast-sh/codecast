"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { VIOLET } from "./kit";

/**
 * The hero's signature visual: session blame on a file, one line selected, and
 * a core drilled from that line down through the sessions underneath the code
 * (newest on top, like sediment) until it reaches the session that wrote it
 * and opens on the message where the value was decided, plus the later
 * message that changed it. Every piece of the core is its own segment at the
 * same x, so the line stays straight at any width without measuring.
 */

const CORE_X = 21; // px from each block's left edge; every segment sits here

type Row = { n: number; code: ReactNode; who?: { id: string; name: string; title: string }; hot?: boolean; sha: string };

const M41 = { id: "jx7m41c", name: "maya", title: "Add jitter to webhook backoff" };
const K2Q = { id: "jx7k2qa", name: "sam", title: "Retry cap for failed webhooks" };
const F9D = { id: "jx7f9de", name: "lee", title: "Stripe webhook ingest" };

const kw = (s: string) => <span style={{ color: SOL.green }}>{s}</span>;
const num = (s: string) => <span style={{ color: SOL.magenta }}>{s}</span>;
const str = (s: string) => <span style={{ color: SOL.cyan }}>{s}</span>;
const fn = (s: string) => <span style={{ color: SOL.blue }}>{s}</span>;

const ROWS: Row[] = [
  { n: 3, sha: "a91f03e", who: F9D, code: <>{kw("import")} {"{ queue }"} {kw("from")} {str('"../queue"')};</> },
  { n: 4, sha: "a91f03e", who: F9D, code: <>{kw("import type")} {"{ WebhookEvent }"} {kw("from")} {str('"./types"')};</> },
  { n: 5, sha: "4b1c9e2", who: K2Q, hot: true, code: <>{kw("export const")} MAX_ATTEMPTS = {num("5")};</> },
  { n: 6, sha: "4b1c9e2", who: K2Q, code: <>{kw("export const")} BASE_DELAY_MS = {num("2_000")};</> },
  { n: 7, sha: "c07d5b1", who: M41, code: <>{kw("export function")} {fn("nextDelay")}(attempt: {kw("number")}) {"{"}</> },
  { n: 8, sha: "c07d5b1", who: M41, code: <>{"  "}{kw("const")} jitter = Math.{fn("random")}() * {num("0.3")};</> },
];

type Stratum = { id: string; who: string; agent: string; age: string; title: string; target?: boolean; past?: boolean };

const STRATA: Stratum[] = [
  { id: "jx7m41c", who: "maya", agent: "codex", age: "3 days ago", title: "Add jitter to webhook backoff" },
  { id: "jx7k2qa", who: "sam", agent: "claude", age: "16 days ago", title: "Retry cap for failed webhooks", target: true },
  { id: "jx7f9de", who: "lee", agent: "cursor", age: "5 weeks ago", title: "Stripe webhook ingest", past: true },
  { id: "jx79bb1", who: "sam", agent: "claude", age: "2 months ago", title: "Queue worker skeleton", past: true },
];

const BAND_TINTS = [
  `color-mix(in srgb, ${SOL.base2} 70%, ${SOL.base3})`,
  `color-mix(in srgb, ${VIOLET} 9%, ${SOL.base2})`,
  `color-mix(in srgb, ${SOL.yellow} 9%, ${SOL.base2})`,
  `color-mix(in srgb, ${SOL.base1} 22%, ${SOL.base2})`,
];

function Seg({ d, top = 0, bottom = 0 }: { d: number; top?: number | string; bottom?: number | string }) {
  return <span aria-hidden className="mm-anim mm-core absolute w-[3px]" style={{ left: CORE_X, top, bottom, backgroundColor: VIOLET, "--d": `${d}s` } as CSSProperties} />;
}

/** Where the core stops: a ring on the session that wrote the line. */
function Stop({ d }: { d: number }) {
  return <span aria-hidden className="mm-anim mm-open absolute rounded-full" style={{ left: CORE_X - 5, top: 13, width: 13, height: 13, backgroundColor: SOL.base3, border: `3px solid ${VIOLET}`, "--d": `${d}s` } as CSSProperties} />;
}

export function HeroStrata() {
  return (
    <div className="relative select-none" role="img" aria-label="Session blame on retry.ts: line 5 traced through three sessions to the session that wrote it, opened on message 88 where the retry cap was set to 3 and the later message that raised it to 5">
      {/* The file */}
      <div className="mm-anim mm-rise relative rounded-t-xl overflow-hidden" style={{ backgroundColor: SOL.base03, border: "1px solid #0a4352", "--d": ".1s" } as CSSProperties}>
        <div className="flex items-center gap-2 px-4 py-2" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #0a4352" }}>
          <span className="text-[11px] font-mono truncate" style={{ color: SOL.base1 }}>src/webhooks/retry.ts</span>
          <span className="ml-auto shrink-0 text-[11px] font-mono" style={{ color: SOL.base01 }}>Blame: <span style={{ color: "#c9cbff" }}>Sessions</span></span>
        </div>
        <div className="relative pt-2 font-mono text-[11px] sm:text-[11.5px] leading-[1.95]">
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-14 z-10" style={{ background: `linear-gradient(90deg, transparent, ${SOL.base03})` }} />
          {ROWS.map((r, i) => (
            <div key={r.n} className={`relative flex whitespace-pre pl-10 pr-3 ${r.hot ? "mm-anim mm-glow" : ""}`} style={r.hot ? ({ backgroundColor: "rgba(108,113,196,.14)", "--d": ".9s" } as CSSProperties) : undefined}>
              {r.hot && <Seg d={1.2} top="50%" bottom={0} />}
              {r.hot && <span aria-hidden className="absolute rounded-full" style={{ left: CORE_X - 4, top: "calc(50% - 5px)", width: 11, height: 11, backgroundColor: VIOLET }} />}
              {ROWS.slice(0, i).some((x) => x.hot) && <Seg d={1.35} />}
              <span className="hidden sm:inline shrink-0 w-[62px]" style={{ color: SOL.base01 }}>{r.sha}</span>
              <span className="shrink-0 w-[108px] sm:w-[200px] truncate pr-2" style={{ color: r.hot ? "#b9bcf0" : SOL.base0 }}>
                <span style={{ color: r.hot ? "#c9cbff" : "#8e92d8" }}>{r.who?.id}</span> {r.who?.name}<span className="hidden sm:inline"> {r.who?.title}</span>
              </span>
              <span className="shrink-0 w-6 text-right pr-3" style={{ color: SOL.base01 }}>{r.n}</span>
              <span style={{ color: SOL.base1 }}>{r.code}</span>
            </div>
          ))}
          <div className="relative h-2"><Seg d={1.4} /></div>
        </div>
      </div>

      {/* Ground line between the code and what lies under it */}
      <div className="relative h-7 flex items-center" style={{ backgroundColor: SOL.base3, borderLeft: "1px solid transparent" }}>
        <Seg d={1.5} />
        <span className="ml-10 font-mono text-[10.5px]" style={{ color: SOL.base1 }}>sessions under this file, newest first</span>
      </div>

      {/* The strata */}
      <div className="rounded-b-xl overflow-hidden" style={{ border: `1px solid ${SOL.base2}` }}>
        {STRATA.map((s, i) => {
          const above = i < STRATA.findIndex((x) => x.target);
          return (
            <div key={s.id} className="mm-anim mm-settle relative" style={{ backgroundColor: BAND_TINTS[i], "--d": `${0.3 + i * 0.12}s`, opacity: s.past ? 0.62 : 1 } as CSSProperties}>
              {above && <Seg d={1.6 + i * 0.15} />}
              {s.target && <><Seg d={1.75} top={0} bottom="calc(100% - 16px)" /><Stop d={2} /></>}
              <div className="flex items-baseline gap-2 sm:gap-3 pl-10 pr-3 py-2.5 font-mono text-[11px] sm:text-[12px]">
                <span className="font-semibold shrink-0 whitespace-nowrap" style={{ color: s.target ? VIOLET : SOL.base01 }}>{s.id}</span>
                <span className="truncate min-w-0" style={{ color: s.target ? SOL.base03 : SOL.base00, fontWeight: s.target ? 600 : 400 }}>{s.title}</span>
                <span className="ml-auto shrink-0 hidden sm:inline" style={{ color: SOL.base1 }}>{s.who} · {s.agent}</span>
                <span className="shrink-0 whitespace-nowrap" style={{ color: SOL.base1 }}>{s.age}</span>
              </div>
              {s.target && (
                <div className="pl-10 pr-3 pb-3 space-y-2">
                  <Msg d={2.2} line={88} who="sam" tone="said">
                    Cap it at 3. Stripe already retries for three days, so ours only covers our own outages.
                  </Msg>
                  <Msg d={2.55} line={141} who="claude" tone="revised">
                    Raised to 5: a deploy drops the queue for longer than three attempts cover. The load test is msg 139.
                  </Msg>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Msg({ d, line, who, tone, children }: { d: number; line: number; who: string; tone: "said" | "revised"; children: ReactNode }) {
  const revised = tone === "revised";
  const c = revised ? SOL.orange : VIOLET;
  return (
    <div className="mm-anim mm-open rounded-md px-3 py-2 text-[12.5px] sm:text-[13px] leading-[1.55]" style={{ backgroundColor: SOL.base3, border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`, boxShadow: "0 8px 20px -14px rgba(0,43,54,.35)", "--d": `${d}s` } as CSSProperties}>
      <div className="flex items-center gap-2 mb-0.5 font-mono text-[10.5px]">
        <span className="px-1.5 rounded" style={{ color: SOL.base3, backgroundColor: c }}>msg {line}</span>
        <span style={{ color: SOL.base1 }}>{who}</span>
        {revised && <span style={{ color: SOL.orange }}>later: changed the answer</span>}
      </div>
      <span style={{ color: SOL.base02 }}>{children}</span>
    </div>
  );
}
