// How a role moves a number (docs/architecture/initiatives-projects-role-page.md
// I4): the guidance `cast brief` carries when the role's area is read by any
// number, a goal's or a project's. Principles, not a script, drawn from what
// long-running optimisation loops and experimentation practice found works:
// read the number whole before acting, change one thing against a stated
// prediction, judge it after a window fixed in advance, keep or revert, write
// down what was learned, and never move the number by moving the measurement.
//
// One text for every reader of a brief (the CLI, the eval worlds), so a role
// reads the same guidance wherever its brief is printed.

export const METRIC_CLIMB_GUIDANCE: readonly string[] = [
  "Your area is read by the numbers above, and moving them toward their targets is the point of your work. Each one stands for a real outcome (people helped, money made, trust kept), so a gain that does not move that outcome is not a gain.",
  "Read a number whole before you act on it: its value against the target, which way the last week moved, and the pace the date needs. A single point inside its usual range is noise; act on a run of points or a clear break from that range, and expect a bad week to recover partly on its own.",
  "Work on the stage that limits the result. In a funnel that is the step converting worst against what it should; more volume into a leaking step, or a fix to a step that is not the constraint, moves nothing.",
  "Change one thing at a time, the smallest change that tests a reason you can name. Before it runs, write the effect you expect and the day you will read it; read it then, not when it looks good, and allow at least a week where the number swings by weekday. Keep what beat the baseline, revert what did not, and drop a gain too small to tell from noise when it adds complexity.",
  "Log each try under `## Experiments` in your brief: the change, the reason, the prediction, the read day and the result. Move a refuted idea to `## Refuted` with what showed it, so no later run tries it again.",
  "A number marked as a guardrail must not get worse while you move the others; a win that costs a guardrail is a loss. Never change how a number is counted, filtered or reported, and say so when the only path to a target you can see is one that games it.",
  "Choose the next piece of work by its expected effect on the number, how sure the log makes you, and its cost. When the trend cannot reach the target by its date, small tuning is the wrong bet: propose the larger change to the person you report to. Spending past your budget, anything hard to undo, and anything said in the company's name in a new way go to a person first.",
];

/** The guidance as `cast brief` prints it, under its heading. */
export const metricClimbLines = (): string[] => ["## Moving your numbers", ...METRIC_CLIMB_GUIDANCE.map((p) => `- ${p}`)];
