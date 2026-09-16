"use client";

// The chrome both hosts of a live browser stream share.
//
// The dock over a conversation (BrowserWatchSplit) and the stage pane
// (backends/StreamBackend) look nothing alike, but a handoff has to read the
// same in both: one button that says "Take the wheel" and flips to "Hand
// back", one hint while the human drives, one address that flashes when the
// agent navigates. Written once here so the two hosts cannot drift apart in
// wording or in state.

import { MousePointerClick } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";

export const WHEEL_TAKE_LABEL = "Take the wheel";
export const WHEEL_BACK_LABEL = "Hand back";

/**
 * The wheel: the daemon offers it on ready, taking it is the human's choice.
 * Sentence case on purpose: it sits beside the row pills ("open tab"), not
 * beside the uppercase status word. Cyan is the human's color throughout the
 * control surface, so the button wears it only while the human drives.
 */
export function WheelButton({
  on,
  onToggle,
  /** Drawn over the frame rather than in a bar: it brings its own backdrop so
   *  it stays readable over any page. */
  floating = false,
}: {
  on: boolean;
  onToggle: () => void;
  floating?: boolean;
}) {
  const tone = on
    ? `text-sol-cyan border-sol-cyan/40 ${floating ? "bg-[color-mix(in_srgb,var(--sol-cyan)_18%,var(--sol-bg))]" : "bg-sol-cyan/15"}`
    : `hover:text-sol-cyan ${floating ? "text-sol-text-muted bg-sol-bg/80 border-sol-border/40" : "text-sol-text-dim/60 border-transparent"}`;
  return (
    <button
      type="button"
      data-sv-wheel
      aria-pressed={on}
      onClick={onToggle}
      title={
        on
          ? "Hand the page back to the agent (Esc)"
          : "Take the wheel: your clicks and typing go to this page, for a sign-in the agent cannot do"
      }
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] leading-4 font-mono whitespace-nowrap transition-colors ${
        floating ? "backdrop-blur-sm" : ""
      } ${tone}`}
    >
      <MousePointerClick className="w-3 h-3" />
      {on ? WHEEL_BACK_LABEL : WHEEL_TAKE_LABEL}
    </button>
  );
}

/** The one line shown over the frame while the human drives: what is true
 *  about the agent, and the way out. */
export function DrivingHint() {
  return (
    <span
      data-sv-driving-hint
      className="absolute bottom-2 left-1/2 -translate-x-1/2 max-w-[calc(100%-16px)] inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sol-bg/90 border border-sol-cyan/40 text-[10px] font-mono text-sol-text-muted whitespace-nowrap pointer-events-none"
    >
      <span className="text-sol-cyan">You have the wheel.</span>
      <span className="truncate">The agent keeps its session; nothing you do here is sent to it.</span>
      <KeyCap size="xs">Esc</KeyCap>
      <span>hands back</span>
    </span>
  );
}

/**
 * The tab's address, flashing when the agent navigates. Keyed on the
 * navigation time so the flash restarts per navigation and never on an
 * unrelated re-render (`nav` is the stream report's, see BrowserStreamReport).
 */
export function WatchAddress({
  url,
  nav,
  className = "",
}: {
  url: string;
  nav: { url: string; at: number } | null;
  className?: string;
}) {
  return (
    <span
      key={nav?.at ?? 0}
      data-sv-watch-url
      className={`text-[10px] font-mono text-sol-text-dim/70 truncate rounded px-0.5 -mx-0.5 ${nav ? "cc-nav-flash" : ""} ${className}`}
      title={url}
    >
      {url}
    </span>
  );
}
