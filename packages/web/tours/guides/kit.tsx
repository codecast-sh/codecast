"use client";
// The pieces a guide's scenes are drawn with (styles: guides.css, "scene
// kit"). A scene is absolutely laid out on the 1040x600 stage and changes
// only data-* states as its beat moves, so every motion is a CSS transition
// and stepping back plays it in reverse.
import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { RoleAvatar } from "../../components/org/avatars";
import { useInboxStore } from "../../store/inboxStore";

type Box = { x: number; y: number; w?: number; h?: number };

const at = (b: Box, style?: CSSProperties): CSSProperties => ({ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, ...style });

/** Shown from a beat on: fades and lifts in, and back out when stepped back. */
export function Show({ on, pop, at: box, className = "", style, children, ...rest }: { on: boolean; pop?: boolean; at?: Box; className?: string; style?: CSSProperties; children?: ReactNode } & Record<`data-${string}`, unknown>) {
  return (
    <div {...rest} className={`${pop ? "gs-pop" : "gs-fade"} ${className}`} data-show={on ? "1" : "0"} style={box ? at(box, style) : style}>
      {children}
    </div>
  );
}

/** An app window on the stage: a title bar and a body. */
export function Win({ title, at: box, children, className = "", style, right }: { title: ReactNode; at: Box; children?: ReactNode; className?: string; style?: CSSProperties; right?: ReactNode }) {
  return (
    <div className={`gs-window ${className}`} style={at(box, style)}>
      <div className="gs-titlebar"><span className="gs-dots"><i /><i /><i /></span>{title}{right ? <span style={{ marginLeft: "auto" }}>{right}</span> : null}</div>
      <div style={{ position: "relative", height: box.h ? box.h - 34 : undefined }}>{children}</div>
    </div>
  );
}

export type WorkState = "working" | "needs_input" | "done" | "dormant" | "idle";

export const STATE_COLOR: Record<WorkState, string> = {
  working: "var(--sol-green)",
  needs_input: "var(--sol-orange)",
  done: "var(--sol-cyan)",
  dormant: "var(--sol-violet)",
  idle: "var(--sol-text-dim)",
};
const STATE_WORD: Record<WorkState, string> = { working: "Working", needs_input: "Needs input", done: "Done", dormant: "Dormant", idle: "Idle" };

export function Dot({ state, size = 8 }: { state: WorkState; size?: number }) {
  return <span className="inline-block rounded-full shrink-0" style={{ width: size, height: size, background: STATE_COLOR[state], boxShadow: state === "working" ? `0 0 0 3px color-mix(in srgb, ${STATE_COLOR[state]} 22%, transparent)` : undefined }} />;
}

export function StatePill({ state }: { state: WorkState }) {
  const c = STATE_COLOR[state];
  return <span className="gs-pill" style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}>{STATE_WORD[state].toUpperCase()}</span>;
}

/** One session, as an inbox row. */
export function SessionRow({ title, state, who, style }: { title: string; state: WorkState; who?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="flex items-center gap-2 px-3 h-[34px] rounded-lg" style={{ background: "var(--sol-card)", border: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)", ...style }}>
      <Dot state={state} />
      <span className="truncate flex-1 text-[12px]">{title}</span>
      {who}
      <StatePill state={state} />
    </div>
  );
}

/** A person: the viewer's own face for "You", initials for the example's people. */
export function Person({ name, size = 28, color = "var(--sol-blue)", you = false }: { name: string; size?: number; color?: string; you?: boolean }) {
  const me = useInboxStore((s) => (you ? (s.currentUser as any) : null));
  const img = you ? me?.image || me?.avatar_url : null;
  if (img) return <img src={img} alt="" className="gs-face object-cover" style={{ width: size, height: size }} />;
  const initial = (you ? me?.name || "You" : name).trim()[0]?.toUpperCase() ?? "?";
  return <span className="gs-face" style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}>{initial}</span>;
}

export function Face({ avatar, size = 28 }: { avatar: string; size?: number }) {
  return <RoleAvatar avatar={avatar} size={size} />;
}

/** The example company's roles, one face each, used across both guides. */
export const ROLES = {
  people: { name: "Head of People", handle: "people", avatar: "owl" },
  product: { name: "Head of Product", handle: "product", avatar: "fox" },
  qa: { name: "QA Lead", handle: "qa", avatar: "hedgehog" },
  growth: { name: "Growth", handle: "growth", avatar: "toucan" },
  payments: { name: "Payments QA", handle: "payments-qa", avatar: "otter" },
  infra: { name: "Infra", handle: "infra", avatar: "bear" },
} as const;
export type RoleKey = keyof typeof ROLES;

/** A role as the chart draws it: face, name, and a line under it. */
export function RoleCard({ role, line, state, at: box, ghost, spot, className = "", children }: { role: RoleKey; line?: ReactNode; state?: WorkState; at?: Box; ghost?: boolean; spot?: boolean; className?: string; children?: ReactNode }) {
  const r = ROLES[role];
  return (
    <div className={`gs-card ${ghost ? "gs-ghost" : ""} ${spot ? "gs-spot" : ""} ${className}`} style={box ? at(box, { padding: "9px 11px" }) : { padding: "9px 11px" }}>
      <div className="flex items-center gap-2.5">
        <Face avatar={r.avatar} size={30} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold truncate leading-tight">{r.name}</div>
          <div className="text-[11px] gs-dim truncate leading-tight mt-0.5 flex items-center gap-1.5">{state && <Dot state={state} size={6} />}{line ?? `@${r.handle}`}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

/** A wire between two stage points, bent once, for charts. */
export function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}

/** The stage-wide SVG layer wires are drawn on. */
export function Wires({ children }: { children: ReactNode }) {
  return <svg className="absolute inset-0 pointer-events-none" width={1040} height={600} aria-hidden>{children}</svg>;
}

/** A button on the stage. `wait`: the beat waits for this press. */
export function StageButton({ children, wait, onPress, primary, style }: { children: ReactNode; wait?: boolean; onPress?: () => void; primary?: boolean; style?: CSSProperties }) {
  return (
    <button type="button" className={`gs-btn ${primary ? "gs-btn-primary" : ""}`} data-wait={wait ? "" : undefined} onClick={wait ? onPress : undefined} style={style} data-guide-stage-act={wait ? "" : undefined}>
      {children}
    </button>
  );
}

/** A count that rolls to its value. */
export function Count({ value, className = "" }: { value: number; className?: string }) {
  return <span key={value} className={`gs-count inline-block ${className}`} style={{ animation: "guide-say-in 400ms ease-out" }}>{value}</span>;
}

/** A small chip: a project, a trigger, a tag. */
export function Chip({ children, color = "var(--sol-text-muted)", style }: { children: ReactNode; color?: string; style?: CSSProperties }) {
  return <span className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md text-[11px] whitespace-nowrap" style={{ color, background: `color-mix(in srgb, ${color} 11%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`, ...style }}>{children}</span>;
}

/** A message in a role's or a session's thread. */
export function Msg({ from, children, you, style }: { from: ReactNode; children: ReactNode; you?: boolean; style?: CSSProperties }) {
  return (
    <div className="flex gap-2.5 items-start" style={style}>
      <span className="shrink-0 mt-0.5">{from}</span>
      <div className="text-[12.5px] leading-[1.5] rounded-xl px-3 py-2" style={{ background: you ? "color-mix(in srgb, var(--guide-accent) 12%, var(--sol-card))" : "var(--sol-card)", border: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)" }}>{children}</div>
    </div>
  );
}

/** False on the first frame, true right after: lets a scene move something
 *  from where it starts as it mounts (a token setting off, findings flying). */
export function useArrived(delay = 80): boolean {
  const [arrived, setArrived] = useState(false);
  useMountEffect(() => {
    const t = window.setTimeout(() => setArrived(true), delay);
    return () => window.clearTimeout(t);
  });
  return arrived;
}

/**
 * A card the person drags to its new place on the stage. Past `threshold`
 * stage pixels the drop counts and `onDrop` runs; the card then glides from
 * where it was let go to where the scene puts it (`to`: that place, relative
 * to where it stood). A click without a drag counts too, for a trackpad or a
 * keyboard. Pointer moves are in screen pixels, read back through the
 * stage's scale.
 */
export function useStageDrag(enabled: boolean, to: { x: number; y: number }, onDrop: () => void, threshold = 70) {
  const start = useRef<{ x: number; y: number; scale: number } | null>(null);
  const [off, setOff] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState(false);
  const moved = useRef(false);
  const drop = (o: { x: number; y: number }) => {
    // From here on the scene places the card at `to`; the offset that keeps it where it was let go then eases to none.
    setLive(true);
    setOff({ x: o.x - to.x, y: o.y - to.y });
    onDrop();
    window.setTimeout(() => { setLive(false); setOff(null); }, 40);
  };
  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!enabled) return;
      const stage = e.currentTarget.closest("[data-guide-stage]") as HTMLElement | null;
      const scale = stage ? stage.getBoundingClientRect().width / 1040 : 1;
      start.current = { x: e.clientX, y: e.clientY, scale };
      moved.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
      setLive(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s) return;
      const o = { x: (e.clientX - s.x) / s.scale, y: (e.clientY - s.y) / s.scale };
      if (Math.hypot(o.x, o.y) > 4) moved.current = true;
      setOff(o);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const o = { x: (e.clientX - s.x) / s.scale, y: (e.clientY - s.y) / s.scale };
      if (!moved.current || Math.hypot(o.x, o.y) >= threshold) drop(moved.current ? o : { x: 0, y: 0 });
      else { setLive(false); setOff(null); }
    },
    onPointerCancel: () => { start.current = null; setLive(false); setOff(null); },
  };
  return { handlers, live, transform: off ? `translate(${off.x}px, ${off.y}px)` : undefined };
}
