// How far a person has opted into codecast, as one ordered list of steps.
// Every opt-in surface (the sidebar meter, its checklist, the nudge strip)
// reads this one model, so a step is "done" by the same rule everywhere and
// the order of what we ask for is declared once.
//
// The order is by value: data (sign-in cohorts, 2026-10-06) says people stay
// when a teammate is on codecast with them and a repo flows to the team, so
// those come right after connecting a computer.

import type { PermissionReadiness } from "./osPermissions";

export type SetupStepKey =
  | "connect"
  | "team"
  | "invite"
  | "share_repo"
  | "share_full"
  | "agents"
  | "notifications"
  | "team_features"
  | "desktop";

export type SetupStep = {
  key: SetupStepKey;
  label: string;
  /** A glance-sized state for the row: "1 of 6 on", "just you". */
  state: string;
  done: boolean;
};

export type SetupTeamFacts = {
  _id: string;
  name: string;
  member_count?: number;
  shared_project_count?: number;
  /** The member's own level is full (lib/teamVisibility). */
  sharesFull: boolean;
  isAdmin: boolean;
  /** Team features on, of those a new team starts with. */
  features: { on: number; total: number };
};

export type SetupFacts = {
  connected: boolean;
  /** The team the person works in now; null when they are on none. */
  team: SetupTeamFacts | null;
  agentFeatures: { on: number; total: number };
  notifications: PermissionReadiness;
  /** The desktop app is offered on this device and has never been used. */
  desktopOffered: boolean;
};

export function setupSteps(f: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [];
  steps.push({ key: "connect", label: "Connect your computer", state: f.connected ? "Connected" : "Not connected", done: f.connected });
  const t = f.team;
  steps.push({ key: "team", label: "Start or join a team", state: t ? t.name : "Solo", done: !!t });
  const members = t?.member_count ?? 1;
  steps.push({
    key: "invite",
    label: "Invite a teammate",
    state: !t ? "Needs a team" : members <= 1 ? "Just you" : `${members} people`,
    done: members >= 2,
  });
  const repos = t?.shared_project_count ?? 0;
  steps.push({
    key: "share_repo",
    label: "Share a repo with the team",
    state: !t ? "Needs a team" : repos === 0 ? "None shared" : `${repos} shared`,
    done: repos >= 1,
  });
  steps.push({
    key: "share_full",
    label: "Show teammates whole sessions",
    state: !t ? "Needs a team" : members <= 1 ? "Needs a teammate" : t.sharesFull ? "Full" : "Partial",
    done: !!t?.sharesFull && members >= 2,
  });
  steps.push({
    key: "agents",
    label: "Turn on agent features",
    state: `${f.agentFeatures.on} of ${f.agentFeatures.total} on`,
    done: f.agentFeatures.total > 0 && f.agentFeatures.on >= f.agentFeatures.total,
  });
  if (f.notifications !== "n/a" && f.notifications !== "unknown") {
    steps.push({
      key: "notifications",
      label: "Get notified when agents need you",
      state: f.notifications === "granted" ? "On" : "Off",
      done: f.notifications === "granted",
    });
  }
  if (t?.isAdmin) {
    steps.push({
      key: "team_features",
      label: "Turn on team features",
      state: `${t.features.on} of ${t.features.total} on`,
      done: t.features.on >= t.features.total,
    });
  }
  if (f.desktopOffered) {
    steps.push({ key: "desktop", label: "Install the Mac app", state: "Browser", done: false });
  }
  return steps;
}

/** The step each step needs done first: an invite needs a team, full
 *  sharing needs someone to share with. */
const NEEDS: Partial<Record<SetupStepKey, SetupStepKey>> = {
  invite: "team",
  share_repo: "team",
  team_features: "team",
  share_full: "invite",
};

export function stepReady(steps: SetupStep[], step: SetupStep): boolean {
  const need = NEEDS[step.key];
  return !need || !!steps.find((s) => s.key === need)?.done;
}

/** The first step the person can take now. */
export function nextStep(steps: SetupStep[]): SetupStep | null {
  return steps.find((s) => !s.done && stepReady(steps, s)) ?? null;
}

/** The steps that are worth a strip across the top of the app, in order:
 *  the ones that turn codecast from a personal log into the team's view. */
export const NUDGE_STEPS: SetupStepKey[] = ["team", "invite", "share_repo", "agents"];

const DAY = 24 * 60 * 60 * 1000;
/** Each dismiss of a step's strip holds longer: 3 days, a week, three weeks,
 *  then two months. The strip keeps asking, more quietly each time. */
export const NUDGE_SNOOZES = [3 * DAY, 7 * DAY, 21 * DAY, 60 * DAY];

export function nudgeSnoozeKey(key: SetupStepKey) {
  return `setup_nudge_${key}` as const;
}
export function nudgeCountKey(key: SetupStepKey) {
  return `setup_nudge_${key}_n` as const;
}

type DismissBag = Record<string, unknown> | undefined;

export function nudgeSnoozedUntil(dismissed: DismissBag, key: SetupStepKey): number {
  const at = Number(dismissed?.[nudgeSnoozeKey(key)] ?? 0);
  if (!at) return 0;
  const n = Math.max(1, Number(dismissed?.[nudgeCountKey(key)] ?? 1));
  return at + NUDGE_SNOOZES[Math.min(n, NUDGE_SNOOZES.length) - 1];
}

/** The one step the strip asks for now: the first undone nudge step that is
 *  not snoozed. A step waits for the ones before it (an invite needs a team). */
export function pickSetupNudge(steps: SetupStep[], dismissed: DismissBag, now = Date.now()): SetupStep | null {
  const connect = steps.find((s) => s.key === "connect");
  if (!connect?.done) return null;
  for (const key of NUDGE_STEPS) {
    const step = steps.find((s) => s.key === key);
    if (!step || step.done || !stepReady(steps, step)) continue;
    if (nudgeSnoozedUntil(dismissed, key) > now) return null;
    return step;
  }
  return null;
}

/** The sidebar meter hides for a week when closed, then comes back. */
export const METER_SNOOZE_MS = 7 * DAY;
