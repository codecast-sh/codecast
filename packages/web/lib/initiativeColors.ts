import { type InitiativeHealth } from "@codecast/shared/contracts/initiative";

export const INITIATIVE_ACCENT = "var(--sol-magenta)";

export const HEALTH_COLOR: Record<InitiativeHealth, string> = {
  none: "var(--sol-text-dim)",
  on_track: "var(--sol-green)",
  at_risk: "var(--sol-yellow)",
  off_track: "var(--sol-red)",
};
