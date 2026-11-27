import { CheckCircle2, Circle, CircleDashed, CircleDot, XCircle, type LucideIcon } from "lucide-react";
import { type InitiativeHealth, type InitiativeStatus } from "@codecast/shared/contracts/initiative";

export const INITIATIVE_ACCENT = "var(--sol-magenta)";

export const HEALTH_COLOR: Record<InitiativeHealth, string> = {
  none: "var(--sol-text-dim)",
  on_track: "var(--sol-green)",
  at_risk: "var(--sol-yellow)",
  off_track: "var(--sol-red)",
};

/** A goal's status as its glyph and colour (InitiativeAtoms StatusGlyph, and the phone's goal screens). */
export const INITIATIVE_STATUS_VISUAL: Record<InitiativeStatus, { icon: LucideIcon; color: string }> = {
  proposed: { icon: CircleDashed, color: "var(--sol-text-dim)" },
  planned: { icon: Circle, color: "var(--sol-text-muted)" },
  active: { icon: CircleDot, color: INITIATIVE_ACCENT },
  completed: { icon: CheckCircle2, color: "var(--sol-text-muted)" },
  cancelled: { icon: XCircle, color: "var(--sol-text-dim)" },
};
