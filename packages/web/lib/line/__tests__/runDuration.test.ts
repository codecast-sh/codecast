import { expect, test } from "bun:test";
import { aboutWords, medianRunMs } from "../runDuration";

const M = 60_000;
const run = (min: number, built = true, status = "completed") => ({ status, created_at: 0, updated_at: min * M, node_statuses: built ? [{ node_id: "build", status: "completed" }] : [{ node_id: "ground", status: "completed" }] });

test("the median of finished runs that built a fix; a run that stopped at grounding is not one", () => {
  expect(medianRunMs([run(200), run(1, false), run(1, false), run(226), run(243), run(1, false)])).toBe(226 * M);
  expect(medianRunMs([run(200), run(220), run(30, true, "failed")])).toBeNull();
  expect(medianRunMs([run(200), run(220), run(240), run(260)])).toBe(230 * M);
});

test("a duration as a label says it", () => {
  expect(aboutWords(226 * M)).toBe("4h");
  expect(aboutWords(40 * M)).toBe("40m");
  expect(aboutWords(26 * 60 * M)).toBe("1d 2h");
});
