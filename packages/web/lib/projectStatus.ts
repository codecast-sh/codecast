// A project's status, in one place: the glyph, the word and the colour the
// projects list, a project's card, its page header and its context menu all
// draw. Goals keep their own table (components/initiatives/InitiativeAtoms
// StatusGlyph), because a goal's statuses are different words.
import { CheckCircle2, Circle, CircleDot, PauseCircle, type LucideIcon } from "lucide-react";

export type ProjectStatus = "active" | "planning" | "paused" | "done";

/** The list's order: what is being worked now, then what is coming, then what stopped. */
export const PROJECT_STATUS_ORDER: readonly ProjectStatus[] = ["active", "planning", "paused", "done"];

export const PROJECT_STATUS: Record<ProjectStatus, { icon: LucideIcon; label: string; color: string; accent: string }> = {
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan", accent: "border-sol-cyan" },
  planning: { icon: Circle, label: "Planning", color: "text-sol-violet", accent: "border-sol-violet" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow", accent: "border-sol-yellow" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green", accent: "border-sol-green" },
};

/** A status nobody wrote down (an old row, a stub) reads as active. */
export const projectStatusOf = (status: string | null | undefined) => PROJECT_STATUS[status as ProjectStatus] ?? PROJECT_STATUS.active;
