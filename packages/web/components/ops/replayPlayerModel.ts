// The replay player's local settings, event inks and words, and the
// viewport fit: what ReplayPlayer and its rail share.
import { useRef, useState } from "react";
import { REPLAY_PLAYER_SPEEDS } from "@codecast/shared/contracts/replayPlayer";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import { opsHref } from "./opsPaths";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { isEmptyInput, netGrade } from "./replayRail";

/** The list under one person, every recording of theirs however short: the person card and the header link both open it. */
export const personListHref = (who: string) => `${opsHref.tab("replays")}?person=${encodeURIComponent(who)}`;

const EV_INK: Partial<Record<ReplayEvent["type"], string>> = {
  nav: "var(--sol-blue)",
  error: "var(--sol-red)",
  mark: "var(--sol-violet)",
  submit: "var(--sol-green)",
  view: "var(--sol-text-dim)",
};

export function inkOf(e: ReplayEvent): string {
  if (e.type === "console") return e.level === "error" ? "var(--sol-red)" : "var(--sol-yellow)";
  if (e.type === "network") return netGrade(e) === "failed" ? "var(--sol-red)" : netGrade(e) === "slow" ? "var(--sol-yellow)" : "var(--sol-text-muted)";
  return EV_INK[e.type] ?? "var(--sol-text-muted)";
}

// The rail's type column: one short word each, so the column stays narrow.
const TYPE_WORD: Record<ReplayEvent["type"], string> = {
  nav: "page", click: "click", input: "type", submit: "submit", key: "key", scroll: "scroll",
  console: "log", network: "net", error: "error", view: "view", mark: "mark",
};
/** An event's kind word in the rail: a field entered without typing is a focus. */
export const wordOf = (e: ReplayEvent) => (isEmptyInput(e) ? "focus" : TYPE_WORD[e.type]);

export type Speed = (typeof REPLAY_PLAYER_SPEEDS)[number];
export const SPEEDS = REPLAY_PLAYER_SPEEDS;
export const SKIP_KEY = "ops.replay.skipIdle";
export const THEATER_KEY = "ops.replay.theater";
export const MUTED_KEY = "ops.replay.mutedEndpoints";
export const ALL_HIDDEN_KEY = "ops.replay.allHidden";
export const RAIL_W_KEY = "ops.replay.railW";
export const RAIL_MIN_PX = 240;
export const RAIL_MAX_PX = 640;
export const URL_SETTLE_MS = 400;

export function readSkip(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {}
}

/** The controls under the stage (scrubber, bar, keys) and the stage's padding: what the stage's height leaves room for. */
export const CONTROLS_PX = 96;
export const STAGE_PAD_PX = 20;

/** The smallest the two-column player gets before the page scrolls to it. */
const FIT_MIN_PX = 420;

/**
 * The player's height so it ends at the bottom of the window: the stage and
 * its controls in view together, with no scroll before anything plays. Read
 * from where the player sits in its scroll container, on open and on resize.
 */
export function useViewportFit(): { ref: (el: HTMLDivElement | null) => void; height: number | null } {
  const [height, setHeight] = useState<number | null>(null);
  const node = useRef<HTMLDivElement | null>(null);
  const measure = () => {
    const el = node.current;
    if (!el || typeof window === "undefined") return;
    let sc: HTMLElement | null = el.parentElement;
    while (sc && typeof window.getComputedStyle === "function" && !/(auto|scroll)/.test(window.getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const scTop = sc ? sc.getBoundingClientRect().top : 0;
    const offset = el.getBoundingClientRect().top - scTop + (sc ? sc.scrollTop : window.scrollY);
    const view = sc ? sc.clientHeight : window.innerHeight;
    const next = Math.max(FIT_MIN_PX, Math.round(view - offset - 14));
    setHeight((prev) => (prev === next ? prev : next));
  };
  useWatchEffect(() => {
    if (typeof window === "undefined") return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured on open and on resize
  }, []);
  const ref = (el: HTMLDivElement | null) => {
    node.current = el;
    if (el) measure();
  };
  return { ref, height };
}

export const RAIL_BLOCK = 100;

export function inBlocks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Where the page opens: `t` (ms, read as seconds from ?t), or `alt` (the same number read as ms) when the seconds run past the recording and the ms do not. */
export function startTime(t: number | null, alt: number | undefined, lengthMs: number | null): number | null {
  if (t === null || alt === undefined || !lengthMs) return t;
  return t > lengthMs + 2_000 && alt <= lengthMs ? alt : t;
}
