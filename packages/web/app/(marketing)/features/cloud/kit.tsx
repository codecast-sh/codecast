"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C as SharedC } from "../kit";

export const BLUE = SOL.blue;
/** The two machines every diagram on the page names. */
export const LAPTOP = "MacBook-Pro";
export const HOST = "ip-172-31-40-243";
export const SESSION = "jx7k2pd";

/** Inline style that sets an animation delay (seconds) on a `.cl-anim` element. */
export function delay(d: number, extra?: CSSProperties): CSSProperties {
  return { ...(extra ?? {}), ["--d" as string]: `${d}s` } as CSSProperties;
}

export type Route = "out" | "back" | "both" | "host";

/**
 * Which way a capability moves things, drawn as a tiny two-node diagram:
 * the page's section marker. Laptop is paper, host is night.
 */
export function RouteMark({ route, dark = false }: { route: Route; dark?: boolean }) {
  const line = dark ? "rgba(147,161,161,.45)" : "rgba(88,110,117,.4)";
  const arrow = route === "out" ? "→" : route === "back" ? "←" : route === "both" ? "⇄" : "·";
  return (
    <div className="inline-flex items-center gap-1.5 font-mono text-[12px]" aria-hidden>
      <span className="px-1.5 py-0.5 rounded border" style={{ backgroundColor: SOL.base3, color: SOL.base01, borderColor: SOL.base1 }}>laptop</span>
      <span className="relative w-10 h-px" style={{ backgroundColor: line }}>
        <span className="absolute left-1/2 -translate-x-1/2 -top-[9px] text-[13px]" style={{ color: BLUE }}>{arrow}</span>
      </span>
      <span className="px-1.5 py-0.5 rounded border" style={{ backgroundColor: SOL.base03, color: SOL.base1, borderColor: "#094959" }}>host</span>
    </div>
  );
}

/** A page section: route mark on the left rail (top on mobile), heading, lede, body. */
export function Section({ id, route, title, lede, children, tone = "paper" }: {
  id: string; route: Route; title: ReactNode; lede: ReactNode; children: ReactNode; tone?: "paper" | "sand" | "night";
}) {
  const dark = tone === "night";
  const bg = tone === "sand" ? SOL.base2 : tone === "night" ? SOL.base03 : SOL.base3;
  return (
    <section id={id} className={`scroll-mt-20 ${dark ? "cl-dark cl-night" : ""}`} style={{ backgroundColor: bg }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <div className="grid grid-cols-1 lg:grid-cols-[150px_1fr] gap-x-8">
          <div className="mb-5 lg:mb-0 lg:pt-2.5"><RouteMark route={route} dark={dark} /></div>
          <div className="min-w-0">
            <h2 className="font-mono font-bold text-[26px] sm:text-[34px] leading-[1.15] tracking-[-0.03em] max-w-3xl [text-wrap:balance]" style={{ color: dark ? SOL.base2 : SOL.base03 }}>
              {title}
            </h2>
            <p className="mt-4 text-[17px] leading-8 max-w-2xl" style={{ color: dark ? SOL.base1 : SOL.base01 }}>{lede}</p>
            <div className="mt-12">{children}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Inline code in prose; `dark` for night sections. */
export function C({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return <SharedC tint={BLUE} dark={dark}>{children}</SharedC>;
}

/** A short supporting paragraph. */
export function Note({ children, className = "", dark = false }: { children: ReactNode; className?: string; dark?: boolean }) {
  return <p className={`text-[15px] leading-7 ${className}`} style={{ color: dark ? SOL.base1 : SOL.base01 }}>{children}</p>;
}

/** A small mono caption with a blue tick. */
export function Caption({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <div className="flex items-start gap-2 font-mono text-[12px] leading-5 mt-3" style={{ color: dark ? SOL.base01 : SOL.base1 }}>
      <span className="mt-[9px] h-px w-3 shrink-0" style={{ backgroundColor: BLUE }} />
      <span>{children}</span>
    </div>
  );
}

/**
 * A window frame for mocks. `machine` decides the chrome: the laptop's windows
 * are paper, the host's are night, so you can always tell where a thing lives.
 */
export function Pane({ machine, title, right, children, className = "", bodyClassName = "p-4" }: {
  machine: "laptop" | "host"; title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  const host = machine === "host";
  return (
    <div
      className={`rounded-xl border overflow-hidden ${className}`}
      style={host
        ? { backgroundColor: "#01232c", borderColor: "#0b4a5a", boxShadow: "0 24px 60px -28px rgba(0,0,0,.6)" }
        : { backgroundColor: "#fffbf0", borderColor: "#e3dcc6", boxShadow: "0 24px 50px -30px rgba(0,43,54,.35)" }}
    >
      <div
        className="flex items-center gap-2 px-3.5 py-2 border-b font-mono text-[11.5px]"
        style={host ? { backgroundColor: SOL.base02, borderColor: "#0b4a5a", color: SOL.base1 } : { backgroundColor: SOL.base2, borderColor: "#e3dcc6", color: SOL.base00 }}
      >
        <span className="flex gap-1.5 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: host ? "#0b4a5a" : "#d9d0b6" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: host ? "#0b4a5a" : "#d9d0b6" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: host ? "#0b4a5a" : "#d9d0b6" }} />
        </span>
        <span className="ml-1 truncate min-w-0">{title}</span>
        {right ? <span className="ml-auto shrink-0">{right}</span> : null}
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

/** A real screenshot of the app, framed like the page's host panes. */
export function Shot({ src, alt, width, height, className = "" }: { src: string; alt: string; width: number; height: number; className?: string }) {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      className={`block w-full h-auto rounded-xl border ${className}`}
      style={{ borderColor: "#0b4a5a", backgroundColor: "#0f2a33", boxShadow: "0 24px 60px -28px rgba(0,0,0,.6)" }}
    />
  );
}

/** A terminal block for either machine; lines are children. */
export function Term({ machine, label, children }: { machine: "laptop" | "host"; label: string; children: ReactNode }) {
  const host = machine === "host";
  return (
    <Pane machine={machine} title={label} bodyClassName="overflow-x-auto">
      <pre className="p-4 font-mono text-[12px] leading-[1.75]" style={{ color: host ? SOL.base0 : SOL.base00 }}>{children}</pre>
    </Pane>
  );
}

/** A prompt line inside a Term. */
export function P$({ children, host = false }: { children: ReactNode; host?: boolean }) {
  return (
    <span>
      <span style={{ color: SOL.green }}>$</span>
      <span style={{ color: host ? SOL.base2 : SOL.base02 }}> {children}</span>
      {"\n"}
    </span>
  );
}

/** A dim output line inside a Term. */
export function Out({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span style={tone ? { color: tone } : undefined}>{children}{"\n"}</span>;
}
