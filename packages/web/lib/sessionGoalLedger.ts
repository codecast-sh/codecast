// The review a session goal goes through before it runs (components/consequential):
// starting or resuming one starts agent turns with no person in each round, so
// the review shows the caps that bound it, who decides what, and how to stop.
import type { SwitchLedger } from "../components/consequential/ConsequentialSwitch";
import { GOAL_IDLE_LIMIT_MS, GOAL_MAX_ROUNDS, GOAL_MAX_STALLS, goalObjectiveProblem } from "@codecast/shared/contracts/sessionGoal";

export function sessionGoalLedger(r: { objective: string; session: string; resume?: boolean }): SwitchLedger {
  const problem = goalObjectiveProblem(r.objective);
  return {
    name: r.resume ? "Resume goal" : "Goal",
    subject: r.session,
    shift: r.resume ? ["Paused", "Running"] : ["Off", "Running"],
    figures: [
      { value: String(GOAL_MAX_ROUNDS), label: "rounds at most" },
      { value: String(GOAL_MAX_STALLS), label: "rounds without progress" },
      { value: `${Math.round(GOAL_IDLE_LIMIT_MS / 60_000)}m`, label: "idle, then pause" },
    ],
    hands: { its: ["The next step each round", "When the goal is met"], yours: ["What it is blocked on", "Pause, resume, clear"] },
    rows: [
      { k: "Objective", v: r.objective.trim() || "None" },
      { k: "Each round", v: "1 agent turn + 1 review" },
      { k: "Review", v: "Tool output only" },
    ],
    stop: "Pause on the goal bar",
    confirm: r.resume ? "Resume goal" : "Start goal",
    keep: "Cancel",
    ...(problem ? { blocked: problem } : {}),
  };
}
