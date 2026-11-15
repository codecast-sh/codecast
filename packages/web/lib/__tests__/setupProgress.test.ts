import { describe, expect, test } from "bun:test";
import {
  NUDGE_SNOOZES,
  nextStep,
  nudgeCountKey,
  nudgeSnoozeKey,
  pickSetupNudge,
  setupSteps,
  type SetupFacts,
} from "../setupProgress";

const team = (over: Partial<NonNullable<SetupFacts["team"]>> = {}) => ({
  _id: "t1",
  name: "Acme",
  member_count: 1,
  shared_project_count: 0,
  sharesFull: true,
  isAdmin: true,
  features: { on: 7, total: 7 },
  ...over,
});

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  connected: true,
  team: null,
  agentFeatures: { on: 0, total: 5 },
  notifications: "granted",
  desktopOffered: false,
  ...over,
});

const keyOf = (s: { key: string } | null) => s?.key ?? null;

describe("setupSteps", () => {
  test("a solo person is asked for a team first, and team steps wait for it", () => {
    const steps = setupSteps(facts());
    expect(keyOf(nextStep(steps))).toBe("team");
    expect(steps.find((s) => s.key === "invite")?.state).toBe("Needs a team");
    expect(steps.find((s) => s.key === "share_full")?.done).toBe(false);
  });

  test("a team of one is not done sharing in full, whatever its level", () => {
    const steps = setupSteps(facts({ team: team() }));
    expect(steps.find((s) => s.key === "share_full")).toMatchObject({ done: false, state: "Needs a teammate" });
    expect(keyOf(nextStep(steps))).toBe("invite");
  });

  test("team features show only for an admin; notifications only where they apply", () => {
    expect(setupSteps(facts({ team: team({ isAdmin: false }) })).some((s) => s.key === "team_features")).toBe(false);
    expect(setupSteps(facts({ notifications: "n/a" })).some((s) => s.key === "notifications")).toBe(false);
  });
});

describe("pickSetupNudge", () => {
  const now = 1_000_000_000_000;

  test("asks nothing before a computer is connected", () => {
    expect(pickSetupNudge(setupSteps(facts({ connected: false })), {}, now)).toBeNull();
  });

  test("asks for the first undone step in order", () => {
    expect(keyOf(pickSetupNudge(setupSteps(facts()), {}, now))).toBe("team");
    expect(keyOf(pickSetupNudge(setupSteps(facts({ team: team({ member_count: 3 }) })), {}, now))).toBe("share_repo");
    expect(
      keyOf(pickSetupNudge(setupSteps(facts({ team: team({ member_count: 3, shared_project_count: 2 }) })), {}, now)),
    ).toBe("agents");
  });

  test("a snoozed step holds the strip back instead of skipping to a later ask", () => {
    const dismissed = { [nudgeSnoozeKey("team")]: now - 1000, [nudgeCountKey("team")]: 1 };
    expect(pickSetupNudge(setupSteps(facts()), dismissed, now)).toBeNull();
  });

  test("each dismiss holds longer", () => {
    const steps = setupSteps(facts());
    const at = (n: number, ago: number) => ({ [nudgeSnoozeKey("team")]: now - ago, [nudgeCountKey("team")]: n });
    expect(pickSetupNudge(steps, at(1, NUDGE_SNOOZES[0] + 1), now)).not.toBeNull();
    expect(pickSetupNudge(steps, at(2, NUDGE_SNOOZES[0] + 1), now)).toBeNull();
    expect(pickSetupNudge(steps, at(2, NUDGE_SNOOZES[1] + 1), now)).not.toBeNull();
    expect(pickSetupNudge(steps, at(9, NUDGE_SNOOZES[2] + 1), now)).toBeNull();
  });
});
