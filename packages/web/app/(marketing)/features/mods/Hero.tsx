"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { featureHref } from "../catalog";
import { LINE, MUTED, TEXT, V, at, ROLLOUT_SOURCE } from "./theme";
import { AppFrame } from "./kit";
import { HoverCard, Pill } from "./objects";
import { CUS_A, CUS_B, INC7, PR, TASK, type Obj } from "./data";
import { RolloutBlock } from "./blocks";

/*
 * The hero: an agent's reply as it arrives. The agent wrote plain ids and a
 * three-field block; each id develops into its live pill, the block into the
 * mod's drawing, and the incident's card opens. Hover any pill to read its
 * card. Resting styles are the END state (kit.tsx MODS_CSS).
 */

const T = { a: 1.3, b: 1.55, block: 2.1, c: 2.9, d: 3.15, e: 3.35, card: 4.1 };

/** One id that starts as what the agent typed and develops into the object. */
function Dev({ o, t, active, onPick, align = "left", wait }: { o: Obj; t: number; active: Obj | null; onPick: (o: Obj) => void; align?: "left" | "right"; wait: boolean }) {
  const on = active?.id === o.id;
  return (
    <span className="relative inline-grid align-baseline" onMouseEnter={() => onPick(o)} onClick={() => onPick(o)}>
      <span className="md-raw [grid-area:1/1] justify-self-start" style={at(t)}><Pill o={o} raw /></span>
      <span className="md-dev [grid-area:1/1] cursor-pointer" style={at(t)}><Pill o={o} hot={on} /></span>
      {on && <CardSlot o={o} align={align} d={wait ? T.card : 0} />}
    </span>
  );
}

/** The open card under a pill. The first waits for the reply to develop; later ones answer the pointer at once. */
function CardSlot({ o, align, d }: { o: Obj; align: "left" | "right"; d: number }) {
  return (
    <span key={o.id} className={`md-pop absolute top-[calc(100%+8px)] z-30 hidden sm:block ${align === "right" ? "right-0" : "left-0"}`} style={at(d)}>
      <HoverCard o={o} />
    </span>
  );
}

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] leading-6" style={{ backgroundColor: "rgba(38,139,210,.1)", color: TEXT }}>
      {children}
    </div>
  );
}

export function Conversation() {
  const [active, setPicked] = useState<Obj | null>(INC7);
  const [touched, setTouched] = useState(false);
  const setActive = (o: Obj | null) => { setPicked(o); setTouched(true); };
  return (
    <AppFrame
      title="Checkout failing for some customers"
      right={<span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />claude · working</span>}
      className="md-in relative"
      style={at(0.2)}
    >
      <div className="p-4 sm:p-5 space-y-4" onMouseLeave={() => setActive(null)}>
        <Bubble>Checkout is failing for some customers. What happened?</Bubble>
        <div className="text-[14px] leading-7 space-y-3" style={{ color: TEXT }}>
          <p>
            The errors start with <Dev o={PR} t={T.a} active={active} onPick={setActive} wait={!touched} align="right" />, which went out in the 2:10 deploy. I opened <Dev o={TASK} t={T.b} active={active} onPick={setActive} wait={!touched} /> to revert it and put the previous build on a canary:
          </p>
          <div className="grid">
            <pre className="md-raw [grid-area:1/1] self-start rounded-md px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap" style={at(T.block, { backgroundColor: "rgba(147,161,161,.14)", color: MUTED })}>{ROLLOUT_SOURCE}</pre>
            <div className="md-dev [grid-area:1/1]" style={at(T.block)}><RolloutBlock d={T.block + 0.3} /></div>
          </div>
          <p>
            Hit hardest: <Dev o={CUS_A} t={T.c} active={active} onPick={setActive} wait={!touched} /> and <Dev o={CUS_B} t={T.d} active={active} onPick={setActive} wait={!touched} align="right" />. Promote the canary once errors hold under 0.5%. Tracking it as <Dev o={INC7} t={T.e} active={active} onPick={setActive} wait={!touched} />.
          </p>
        </div>
      </div>
    </AppFrame>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden md-grid-bg" style={{ backgroundColor: SOL.base3 }}>
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: "radial-gradient(56rem 30rem at 82% -8%, rgba(108,113,196,.18), transparent 62%), radial-gradient(30rem 20rem at 0% 100%, rgba(42,161,152,.08), transparent 70%)" }}
      />
      <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-16 sm:pb-24">
        <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-10 lg:gap-14 items-start">
          <div className="min-w-0 lg:pt-6">
            <Link href="/features" className="md-in inline-flex items-center gap-2 text-[13px] font-mono hover:underline" style={at(0, { color: SOL.base00 })}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: V }} />Mods
            </Link>
            <h1 className="md-in mt-5 font-mono font-bold text-[34px] sm:text-[46px] leading-[1.06] tracking-[-0.04em] [text-wrap:balance]" style={at(0.08, { color: SOL.base03 })}>
              Live cards for your own objects, in every agent reply.
            </h1>
            <p className="md-in mt-6 text-[17px] sm:text-[18px] leading-8 max-w-xl" style={at(0.16, { color: SOL.base01 })}>
              Codecast already draws its own objects as live references: a task, a pull request, a decision. A mod adds yours, like incidents, customers, deploys or rows in your own product. An agent writes a short id, and you see the object with its current state, a card on hover and a page one click away.
            </p>
            <div className="md-in mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[14px]" style={at(0.24)}>
              <a href="#install" className="font-semibold underline underline-offset-4" style={{ color: SOL.base02, textDecorationColor: V }}>Install codecast</a>
              <a href="#your-kinds" className="underline underline-offset-4" style={{ color: SOL.base01, textDecorationColor: LINE }}>Add a kind</a>
              <Link href={featureHref("publish")} className="underline underline-offset-4" style={{ color: SOL.base01, textDecorationColor: LINE }}>Publish</Link>
            </div>
            <dl className="md-in mt-10 grid grid-cols-3 gap-4 max-w-md" style={at(0.32)}>
              {[["16", "kinds built in"], ["9", "field types for yours"], ["0", "deploys to change a mod"]].map(([n, l]) => (
                <div key={l}>
                  <dt className="font-mono text-[28px] font-bold leading-none tracking-tight" style={{ color: V }}>{n}</dt>
                  <dd className="mt-1.5 text-[12.5px] leading-5" style={{ color: MUTED }}>{l}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="min-w-0 pb-24 sm:pb-40">
            <Conversation />
          </div>
        </div>
      </div>
    </section>
  );
}
