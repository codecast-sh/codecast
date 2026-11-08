import type { CSSProperties } from "react";
import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";
import { SOL } from "../../blog/blogChrome";
import { ICONS, type IconKey } from "./icons";

/*
 * The org page's data and values: colours, the illustrative org every section
 * draws from, and the page's motion CSS. Components live in kit.tsx.
 */

export { SOL };
export const INK = SOL.base03;
export const TEXT = SOL.base02;
export const BODY = SOL.base01;
export const MUTED = SOL.base00;
export const DIM = SOL.base1;
export const LINE = "rgba(88,110,117,.22)";
export const PAPER = SOL.base3;
export const SAND = SOL.base2;

export type Accent = RoleIcon["accent"];
export const ACCENT: Record<Accent, string> = {
  blue: SOL.blue, cyan: SOL.cyan, green: SOL.green, yellow: SOL.yellow,
  orange: SOL.orange, red: SOL.red, magenta: SOL.magenta, violet: SOL.violet,
};

/** A soft fill of `c` over the page paper. */
export const tint = (c: string, pct: number, over: string = PAPER) => `color-mix(in srgb, ${c} ${pct}%, ${over})`;

/** Delay a CSS animation by `t` seconds (the page's motion reads --d). */
export const at = (t: number, style: CSSProperties = {}): CSSProperties => ({ ...style, ["--d" as string]: `${t}s` });


/** The accent colour of a role's icon. */
export const accentOf = (k: IconKey): string => ACCENT[(ICONS[k] as RoleIcon).accent];

// ---- The illustrative org --------------------------------------------------

export type SessionState = "working" | "needs" | "dormant" | "done";
export const STATE: Record<SessionState, { word: string; color: string }> = {
  working: { word: "working", color: SOL.green },
  needs: { word: "needs you", color: SOL.yellow },
  dormant: { word: "dormant", color: SOL.blue },
  done: { word: "done", color: SOL.cyan },
};

export type PersonRow = { id: string; name: string; initials: string; color: string; handle: string };
export type RoleRow = { id: string; title: string; handle: string; k: IconKey; reportsTo: string; area: string };

export const PEOPLE: PersonRow[] = [
  { id: "maya", name: "Maya Chen", initials: "MC", color: SOL.base02, handle: "@maya" },
  { id: "leo", name: "Leo Park", initials: "LP", color: SOL.base01, handle: "@leo" },
  { id: "ines", name: "Ines Ruiz", initials: "IR", color: SOL.base00, handle: "@ines" },
];

/** A small product company's org: Maya runs it, three leads report to her, each with roles under them. */
export const ROLES: RoleRow[] = [
  { id: "eng", title: "Engineering lead", handle: "@eng", k: "terminal window", reportsTo: "maya", area: "Product and the codebase" },
  { id: "growth", title: "CMO", handle: "@cmo", k: "billboard", reportsTo: "maya", area: "Growth: site, ads, social" },
  { id: "people", title: "Head of People", handle: "@head-of-people", k: "org chart", reportsTo: "maya", area: "The org itself, and whatever no narrower role covers" },
  { id: "infra", title: "Head of Infrastructure", handle: "@infra", k: "cloud", reportsTo: "eng", area: "Servers, deploys, costs" },
  { id: "release", title: "Release Captain", handle: "@release", k: "rocket launch", reportsTo: "eng", area: "What ships, and when" },
  { id: "mobile", title: "Head of Mobile", handle: "@mobile", k: "smartphone", reportsTo: "eng", area: "The iOS and Android apps" },
  { id: "evals", title: "Evals lead", handle: "@evals", k: "lab flask", reportsTo: "eng", area: "Prompt and model quality" },
  { id: "social", title: "Social lead", handle: "@social", k: "share nodes", reportsTo: "growth", area: "Posts from what shipped" },
  { id: "ads", title: "Paid Ads lead", handle: "@paid-ads", k: "ad click", reportsTo: "growth", area: "Search ads and budget" },
  { id: "support", title: "Customer Success lead", handle: "@success", k: "customer check", reportsTo: "people", area: "Customer mail and escalations" },
];

export const role = (id: string): RoleRow => ROLES.find((r) => r.id === id)!;
export const person = (id: string): PersonRow => PEOPLE.find((p) => p.id === id)!;

// ---- Motion ----------------------------------------------------------------

/**
 * Every animated element rests in its final state; animations only play the
 * way in. `[data-static]` on the root (?static) and reduced motion skip them,
 * so a background tab or a prerender still reads complete.
 */
export const ORG_CSS = `
.og-root { --og-ease: cubic-bezier(.2,.75,.2,1); }
.og-anim { animation-duration: .7s; animation-timing-function: var(--og-ease); animation-fill-mode: both; animation-delay: var(--d, 0s); }
.og-rise { animation-name: og-rise; }
.og-pop { animation-name: og-pop; animation-duration: .55s; animation-timing-function: cubic-bezier(.3,1.4,.5,1); }
.og-draw { animation-name: og-draw; animation-duration: .9s; stroke-dasharray: 1; stroke-dashoffset: 0; }
.og-fade { animation-name: og-fade; }
@keyframes og-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes og-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
@keyframes og-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes og-fade { from { opacity: 0; } to { opacity: 1; } }
.og-grid {
  background-color: ${PAPER};
  background-image:
    linear-gradient(to right, rgba(88,110,117,.07) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(88,110,117,.07) 1px, transparent 1px);
  background-size: 24px 24px;
}
.og-lift { transition: transform .25s var(--og-ease), box-shadow .25s ease, border-color .2s ease, background-color .2s ease; }
.og-lift:hover { transform: translateY(-2px); }
.og-press { transition: transform .12s ease, background-color .18s ease, color .18s ease, border-color .18s ease; }
.og-press:active { transform: scale(.97); }
.og-root[data-static] .og-anim { animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .og-anim { animation: none !important; }
  .og-lift, .og-lift:hover, .og-press { transition: none; transform: none; }
}
`;
