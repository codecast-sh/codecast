import type { EntityType } from "./entityLinks";

// Every class literal in full — Tailwind's scanner never sees a composed
// string like `hover:${accent.text}`, so composition would silently produce
// no CSS at all. The strip tint is stronger in light mode (a 6% wash reads
// as nothing on white); `borderOpen`/`stripOpen` are the open-state raise, so
// an expanded card reads as open at a glance, not just by its chevron.
export type Accent = {
  text: string;
  hoverText: string;
  border: string;
  borderOpen: string;
  borderHover: string;
  strip: string;
  stripOpen: string;
  stripBorder: string;
  ring: string;
  chevronHover: string;
  bar: string;
};
export const ACCENT: Record<EntityType, Accent> = {
  session: { text: "text-sol-blue", hoverText: "hover:text-sol-blue", border: "border-sol-blue/25", borderOpen: "border-sol-blue/45", borderHover: "hover:border-sol-blue/45", strip: "bg-sol-blue/10 dark:bg-sol-blue/[0.06]", stripOpen: "bg-sol-blue/[0.15] dark:bg-sol-blue/10", stripBorder: "border-sol-blue/15", ring: "focus-visible:ring-sol-blue/35", chevronHover: "group-hover/card:text-sol-blue", bar: "bg-sol-blue" },
  task: { text: "text-sol-violet", hoverText: "hover:text-sol-violet", border: "border-sol-violet/25", borderOpen: "border-sol-violet/45", borderHover: "hover:border-sol-violet/45", strip: "bg-sol-violet/10 dark:bg-sol-violet/[0.06]", stripOpen: "bg-sol-violet/[0.15] dark:bg-sol-violet/10", stripBorder: "border-sol-violet/15", ring: "focus-visible:ring-sol-violet/35", chevronHover: "group-hover/card:text-sol-violet", bar: "bg-sol-violet" },
  plan: { text: "text-sol-cyan", hoverText: "hover:text-sol-cyan", border: "border-sol-cyan/25", borderOpen: "border-sol-cyan/45", borderHover: "hover:border-sol-cyan/45", strip: "bg-sol-cyan/10 dark:bg-sol-cyan/[0.06]", stripOpen: "bg-sol-cyan/[0.15] dark:bg-sol-cyan/10", stripBorder: "border-sol-cyan/15", ring: "focus-visible:ring-sol-cyan/35", chevronHover: "group-hover/card:text-sol-cyan", bar: "bg-sol-cyan" },
  doc: { text: "text-sol-green", hoverText: "hover:text-sol-green", border: "border-sol-green/25", borderOpen: "border-sol-green/45", borderHover: "hover:border-sol-green/45", strip: "bg-sol-green/10 dark:bg-sol-green/[0.06]", stripOpen: "bg-sol-green/[0.15] dark:bg-sol-green/10", stripBorder: "border-sol-green/15", ring: "focus-visible:ring-sol-green/35", chevronHover: "group-hover/card:text-sol-green", bar: "bg-sol-green" },
  trigger: { text: "text-sol-orange", hoverText: "hover:text-sol-orange", border: "border-sol-orange/25", borderOpen: "border-sol-orange/45", borderHover: "hover:border-sol-orange/45", strip: "bg-sol-orange/10 dark:bg-sol-orange/[0.06]", stripOpen: "bg-sol-orange/[0.15] dark:bg-sol-orange/10", stripBorder: "border-sol-orange/15", ring: "focus-visible:ring-sol-orange/35", chevronHover: "group-hover/card:text-sol-orange", bar: "bg-sol-orange" },
  project: { text: "text-sol-text-muted", hoverText: "hover:text-sol-text-muted", border: "border-sol-border", borderOpen: "border-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)]", borderHover: "hover:border-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)]", strip: "bg-sol-bg-alt", stripOpen: "bg-sol-bg-alt", stripBorder: "border-sol-border", ring: "focus-visible:ring-[color-mix(in_srgb,var(--sol-text-dim)_35%,transparent)]", chevronHover: "group-hover/card:text-sol-text-muted", bar: "bg-sol-text-dim" },
};

