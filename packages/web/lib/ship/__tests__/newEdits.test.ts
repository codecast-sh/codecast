import { describe, expect, test } from "bun:test";
import { editedSince, fixRounds } from "../newEdits";
import { UNION_CHANGE_FLOW, UNION_FLAT_RUN } from "../journeyFixtures";
import { pushedFlow } from "../../line/flowPool";

// Ship again on a run that landed its change is offered only for an edit the run did not take: one made after it
// started, outside the session's own fix rounds (whose edits went out with it). Bash, reads and the person's words are no edit.
const flow = pushedFlow({ _id: "wf_union_change", ...UNION_CHANGE_FLOW });
// The run took its change at 100, sent findings back to the session from 200 to 300 (Fix findings), and merged at 400.
const run = { ...UNION_FLAT_RUN, created_at: 100, node_statuses: [...UNION_FLAT_RUN.node_statuses, { node_id: "fix", status: "completed", started_at: 200, completed_at: 300 }] };
const msg = (timestamp: number, ...tools: string[]) => ({ timestamp, tool_calls: tools.map((name) => ({ name })) });
const offered = (messages: ReturnType<typeof msg>[]) => editedSince(messages, run.created_at, fixRounds(flow, run));

describe("whether a landed run's session has edits it did not take", () => {
  test("the session's fix rounds are its subject steps, by the ids the journey reads", () => {
    expect(fixRounds(flow, run)).toEqual([[200, 300]]);
  });
  test("no edits since the run started: nothing to ship", () => {
    expect(offered([msg(50, "Edit"), msg(150, "Bash"), msg(450, "Read", "Bash"), msg(500)])).toBe(false);
  });
  test("an edit inside a fix round went out with the run", () => {
    expect(offered([msg(250, "Edit"), msg(260, "Write"), msg(450, "Bash")])).toBe(false);
  });
  test("an edit after the merge, or while CI ran outside a fix round, is new", () => {
    expect(offered([msg(250, "Edit"), msg(450, "Edit")])).toBe(true);
    expect(offered([msg(150, "MultiEdit")])).toBe(true);
    expect(offered([msg(500, "NotebookEdit")])).toBe(true);
  });
  test("an edit before the run started is the run's own change", () => {
    expect(offered([msg(90, "Edit"), msg(150, "Bash")])).toBe(false);
  });
});
