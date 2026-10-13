import { expect, test } from "bun:test";
import { aboutWords, medianRunMs, workMs } from "../runDuration";

const M = 60_000;
/** A run whose steps ran back to back for these minutes each. */
const steps = (...parts: Array<[string, number]>) => {
  let at = 0;
  return parts.map(([node_id, min]) => ({ node_id, status: "completed", started_at: at, completed_at: (at += min * M) }));
};
const run = (min: number, built = true, status = "completed") => ({ status, node_statuses: steps(["ground", 1], ...(built ? [["build", min - 1] as [string, number]] : [])) });

test("the median working time of finished runs that built a fix; a run that stopped at grounding is not one", () => {
  expect(medianRunMs([run(20), run(1, false), run(1, false), run(26), run(43), run(1, false)])).toBe(26 * M);
  expect(medianRunMs([run(20), run(22), run(180, true, "failed")])).toBeNull();
  expect(medianRunMs([run(20), run(22), run(24), run(26)])).toBe(23 * M);
});

test("a card that waited 3h on a person, or a plan gate, is not the run's length; steps after the card are not either", () => {
  const r = { node_statuses: steps(["ground", 2], ["plan_gate", 190], ["prove", 8], ["implement", 24], ["proposal_gate", 60], ["decide", 195], ["ship", 2]) };
  expect(workMs(r)).toBe(34 * M);
  const finished = (extra: number) => ({ status: "completed", node_statuses: steps(["prove", 5], ["build", 20 + extra], ["decide", 190], ["ship", 1]) });
  expect(medianRunMs([finished(0), finished(5), finished(10)])).toBe(30 * M);
});

test("a duration as a label says it", () => {
  expect(aboutWords(226 * M)).toBe("4h");
  expect(aboutWords(40 * M)).toBe("40m");
  expect(aboutWords(26 * 60 * M)).toBe("1d 2h");
});
