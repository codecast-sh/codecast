// How an agent feature looks wherever the app shows it: its icon and its
// category's accent. Shared by the Agent features page, the illustrations and
// the upsells, so a feature reads the same in every place it appears.
import {
  AlarmClock, AppWindow, Blocks, Brain, CheckCheck, Gauge, GitFork, GitPullRequest, Globe, Layers, LayoutDashboard,
  ListChecks, MessagesSquare, Monitor, Network, Phone, Pin, Puzzle, Scale, Send, Smartphone, SquareSlash, Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { snippetBySlug, type SnippetCategory } from "@codecast/shared/contracts";

const ICONS: Record<string, LucideIcon> = {
  stable: Layers,
  memory: Brain,
  state: Pin,
  messaging: Send,
  forks: GitFork,
  decide: Scale,
  chat: MessagesSquare,
  calls: Phone,
  tasks: ListChecks,
  triggers: AlarmClock,
  workflows: Workflow,
  orchestration: Network,
  skills: SquareSlash,
  pr: GitPullRequest,
  visual: LayoutDashboard,
  publish: Globe,
  mods: Puzzle,
  browser: AppWindow,
  computer: Monitor,
  sim: Smartphone,
  check: CheckCheck,
  limits: Gauge,
};

export function featureIcon(slug: string): LucideIcon {
  return ICONS[slug] ?? Blocks;
}

export interface Tone {
  text: string;
  tile: string;
  on: string;
  dot: string;
  /** A soft wash for an illustration's highlighted element. */
  wash: string;
  /** A solid fill for small marks (bars, dots) inside an illustration. */
  fill: string;
}

/** Literal class strings per category, so Tailwind sees every one. */
export const TONE: Record<SnippetCategory, Tone> = {
  context: { text: "text-sol-cyan", tile: "bg-sol-cyan/10 text-sol-cyan", on: "border-sol-cyan/40", dot: "bg-sol-cyan", wash: "bg-sol-cyan/10 border-sol-cyan/30", fill: "bg-sol-cyan" },
  together: { text: "text-sol-violet", tile: "bg-sol-violet/10 text-sol-violet", on: "border-sol-violet/40", dot: "bg-sol-violet", wash: "bg-sol-violet/10 border-sol-violet/30", fill: "bg-sol-violet" },
  work: { text: "text-sol-blue", tile: "bg-sol-blue/10 text-sol-blue", on: "border-sol-blue/40", dot: "bg-sol-blue", wash: "bg-sol-blue/10 border-sol-blue/30", fill: "bg-sol-blue" },
  show: { text: "text-sol-magenta", tile: "bg-sol-magenta/10 text-sol-magenta", on: "border-sol-magenta/40", dot: "bg-sol-magenta", wash: "bg-sol-magenta/10 border-sol-magenta/30", fill: "bg-sol-magenta" },
  hands: { text: "text-sol-orange", tile: "bg-sol-orange/10 text-sol-orange", on: "border-sol-orange/40", dot: "bg-sol-orange", wash: "bg-sol-orange/10 border-sol-orange/30", fill: "bg-sol-orange" },
};

/** Stable context is a hook, not a catalog snippet; it files under Context. */
export function featureCategory(slug: string): SnippetCategory {
  return slug === "stable" ? "context" : snippetBySlug(slug)?.category ?? "context";
}

export function featureTone(slug: string): Tone {
  return TONE[featureCategory(slug)];
}
