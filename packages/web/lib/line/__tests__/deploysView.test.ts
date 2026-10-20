import { describe, expect, test } from "bun:test";
import { activityChart, carriedRows, carriesOf, waitingToGoOut } from "../deploysView";
import { entityRoute, entityTypeFromId } from "../../entityLinks";

// The Deploys view's model (deploys.md DP7), on synthetic problems.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);

const issue = (id: string, ref: string, occurrences: number[], ships: any[] = []) => ({
  id, ref, title: `Problem ${ref}`, history: { occurrences: occurrences.map((at) => ({ at })), ships },
}) as any;
const ship = (runId: string, sha: string, at: number, deploys: any[] = []) => ({ runId, merge: { sha, at, branch: "b", into: "main" }, deploys });
const deploy = (over: Record<string, any>) => ({
  _id: "d1", deploy_id: "d1", short_id: "dp-1", project_id: "p1", status: "live", at: NOW - DAY, created_at: NOW - DAY,
  target: "production", carries: [], after: null, ...over,
}) as any;

describe("waiting to go out", () => {
  test("a merged fix no deploy carried waits, per project; one a deploy carried does not", () => {
    const issues = [
      issue("t1", "ct-1", [], [ship("r1", "aaaaaaa", NOW - 2 * DAY)]),
      issue("t2", "ct-2", [], [ship("r2", "bbbbbbb", NOW - 3 * DAY, [{ id: "d0" }])]),
    ];
    const groups = waitingToGoOut(issues, [], () => "p1");
    expect(groups).toHaveLength(1);
    expect(groups[0].fixes.map((f) => f.ref)).toEqual(["ct-1"]);
    expect(groups[0].open).toBeNull();
  });

  test("a fix an open deploy is sending leaves the waiting list and shows under the deploy", () => {
    const issues = [issue("t1", "ct-1", [], [ship("r1", "aaaaaaa", NOW - 2 * DAY)])];
    const open = deploy({ status: "running", carries: [{ task_id: "t1", run_id: "r1", how: "sent" }] });
    const [g] = waitingToGoOut(issues, [open], () => "p1");
    expect(g.fixes).toEqual([]);
    expect(g.open?.short_id).toBe("dp-1");
  });
});

describe("the activity chart and a deploy's carried problems", () => {
  test("findings bucket per day; the picked deploy's carried problems are their own series", () => {
    const issues = [issue("t1", "ct-1", [NOW - 5 * DAY, NOW - 4 * DAY]), issue("t2", "ct-2", [NOW - 4 * DAY])];
    const d = deploy({ carries: [{ task_id: "t1", how: "sent" }] });
    const c = activityChart(issues, [{ ...d, tone: "good", label: "dp-1" }], d, NOW);
    expect(c.all.reduce((a, b) => a + b, 0)).toBe(3);
    expect(c.carried!.reduce((a, b) => a + b, 0)).toBe(2);
    expect(c.deploys).toEqual([expect.objectContaining({ short_id: "dp-1", picked: true })]);
  });

  test("a carried problem reads its findings the week before and the week after the deploy", () => {
    const issues = [issue("t1", "ct-1", [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY / 2, NOW + 9 * DAY])];
    const d = deploy({ carries: [{ task_id: "t1", task_short_id: "ct-1", decision_short_id: "sd-4", how: "sent" }], after: { problems: [{ task_id: "t1", findings: 1, reopened: true }] } });
    expect(carriedRows(d, issues)).toEqual([expect.objectContaining({ ref: "ct-1", decisionRef: "sd-4", before: 2, findings: 1, reopened: true })]);
  });
});

describe("what a deploy carried", () => {
  test("a fix the history says it carried (a pull request merged by hand) counts, beside what the server recorded", () => {
    const shipped = ship("r9", "ccccccc", NOW - 2 * DAY, [{ id: "d1", ref: "dp-1", how: "deployed after the merge" }]);
    const issues = [issue("t9", "ct-9", [NOW - 3 * DAY], [shipped]), issue("t1", "ct-1", [])];
    const d = deploy({ carries: [{ task_id: "t1", how: "sent" }] });
    expect(carriesOf(d, issues).map((c) => [c.task_id, c.how])).toEqual([["t1", "sent"], ["t9", "deployed after the merge"]]);
  });
});

describe("dp-N is a reference", () => {
  test("it reads as a deploy and opens on the Line app's Deploys view", () => {
    expect(entityTypeFromId("dp-12")).toBe("deploy");
    expect(entityTypeFromId("dp-x")).toBeNull();
    expect(entityRoute("deploy", "dp-12")).toBe("/line?view=deploys&deploy=dp-12");
  });
});
