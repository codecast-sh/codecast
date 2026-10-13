// A plan's status, in one place: the glyph, the word and the colour the plan
// page, its status menu and an org proposal that moves a plan all draw.
import { CheckCircle2, Circle, CircleDot, PauseCircle, XCircle, type LucideIcon } from "lucide-react";

export const PLAN_STATUS_CONFIG: Record<string, { icon: LucideIcon; label: string; color: string; bg: string }> = {
  draft: { icon: Circle, label: "Draft", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10 border-sol-text-dim/30" },
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan", bg: "bg-sol-cyan/10 border-sol-cyan/30" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow", bg: "bg-sol-yellow/10 border-sol-yellow/30" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green", bg: "bg-sol-green/10 border-sol-green/30" },
  abandoned: { icon: XCircle, label: "Abandoned", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10 border-sol-text-dim/30" },
};
