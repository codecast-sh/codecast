"use client";

import type { CSSProperties, ReactNode } from "react";
import { PROBLEM } from "./story";
import { SOL } from "../../blog/blogChrome";
import { DIM, FLOOR, FLOOR_2, FLOOR_LINE, HAIR, INK, LINE, PAPER, SAND, TEXT, tint } from "./base";

export { C, CopyCommand, ForScripts, Shot } from "../kit";

/**
 * A page section. The number ties it to a station on the sticky pipeline
 * (`Rail` in Page.tsx); `tone` picks the band.
 */
export function Section({ id, title, lede, children, tone = "plain", wide = false, ticket }: {
  id: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  tone?: "plain" | "paper" | "sand" | "floor";
  wide?: boolean;
  /** Where the story's problem stands at this station (see `Ticket`). */
  ticket?: TicketProps;
}) {
  const dark = tone === "floor";
  const bg = dark ? FLOOR : tone === "paper" ? PAPER : tone === "sand" ? SAND : SOL.base3;
  return (
    <section id={id} data-station={id} className={`flx-section relative scroll-mt-24 ${dark ? "flx-dark flx-floor-grid" : ""}`} style={{ backgroundColor: bg }}>
      <div className={`${wide ? "max-w-7xl" : "max-w-6xl"} mx-auto px-5 sm:px-8 pt-20 pb-14 sm:pt-24 sm:pb-16`}>
        <div className={ticket ? "grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-x-14 gap-y-8 items-end" : ""}>
          <div className="min-w-0">
            <h2 className="font-mono font-bold text-[27px] sm:text-[38px] leading-[1.1] tracking-[-0.035em] max-w-4xl [text-wrap:balance]" style={{ color: dark ? SOL.base3 : INK }}>
              {title}
            </h2>
            {lede ? <div className="flx-prose mt-5 max-w-2xl text-[16.5px] sm:text-[17.5px] leading-[1.7]" style={{ color: dark ? SOL.base1 : TEXT }}>{lede}</div> : null}
          </div>
          {ticket ? <Ticket {...ticket} dark={dark} /> : null}
        </div>
        {children ? <div className="mt-12 sm:mt-14">{children}</div> : null}
      </div>
    </section>
  );
}

/** The stations a problem passes, in order; the ticket lights the one it is at. */
const TICKET_STOPS = ["Signal", "Triage", "Build", "Checks", "Live", "Watch", "Traced"];

export type TicketProps = {
  /** Index into the stops above. */
  at: number;
  /** The state at this station: a few words. */
  state: ReactNode;
  /** One value worth showing (a count, a sha). */
  value?: ReactNode;
  /** Whose ticket: the story's task by default; the trace switches to the cause. */
  id?: string;
  title?: string;
  color?: string;
  /** The value's colour when it differs from the ticket's (a regret in red, a person's wait in blue). */
  valueColor?: string;
};

/**
 * The story's problem as it stands at this section's station. The same
 * ticket appears in every section header, moved one stop along, so a reader
 * can follow one problem down the page.
 */
export function Ticket({ at, state, value, id = PROBLEM.task, title = PROBLEM.title, color = LINE, valueColor, dark = false }: TicketProps & { dark?: boolean }) {
  const ink = dark ? SOL.base2 : INK;
  return (
    <div className="flx-ticket rounded-xl border p-4" style={{ borderColor: dark ? FLOOR_LINE : HAIR, backgroundColor: dark ? FLOOR_2 : PAPER }}>
      <div className="flex items-start gap-2 font-mono text-[12px]">
        <span className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-semibold" style={{ color, backgroundColor: tint(color, 14) }}>{id}</span>
        <span className="min-w-0 font-semibold leading-[1.45]" style={{ color: ink }}>{title}</span>
      </div>
      <ol className="flx-ticket-stops mt-3.5" aria-label="Where it stands">
        {TICKET_STOPS.map((s, i) => (
          <li key={s} data-state={i < at ? "done" : i === at ? "here" : "ahead"} style={{ ["--c" as string]: color }}>
            <span className="flx-ticket-dot" aria-hidden />
            <span className="flx-ticket-name">{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-baseline justify-between gap-3 font-mono text-[12.5px]">
        <span style={{ color: dark ? SOL.base1 : TEXT }}>{state}</span>
        {value ? <span className="font-semibold shrink-0" style={{ color: valueColor ?? color }}>{value}</span> : null}
      </div>
    </div>
  );
}

/** A count chip the way the app draws it: a person's wait in blue, the line's work in cyan. */
export function Mark({ color, children }: { color: string; children: ReactNode }) {
  return <span className="flx-mark" style={{ color, backgroundColor: tint(color, 11) }}>{children}</span>;
}

/** A card surface for mocks of the app (light). */
export function Card({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`rounded-xl border ${className}`} style={{ backgroundColor: PAPER, borderColor: HAIR, boxShadow: "0 18px 40px -30px rgba(0,43,54,.45)", ...style }}>
      {children}
    </div>
  );
}

/** A small mono label above a figure panel (sentence case, never uppercase). */
export function Label({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return <div className="font-mono text-[12px] font-semibold" style={{ color }}>{children}</div>;
}

/** A person, drawn small beside a step a person decides. */
export function PersonGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="inline-block shrink-0">
      <circle cx="8" cy="5.2" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 14c.6-2.9 2.7-4.4 5.2-4.4s4.6 1.5 5.2 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
