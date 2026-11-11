import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { verifyMissingArmed } from "../useSyncTriggers";

// The app-wide trigger feed asks for armed triggers and a recent tail of
// finished ones, so a run no longer re-sends the whole history. An armed row
// the answer stops carrying is checked by id: it may have finished outside
// the tail (kept, now finished) or be gone (dropped). Nothing else is touched.
const id = (n: number) => `rx7${String(n).padStart(29, "0")}`;
const row = (n: number, status: string) => ({ _id: id(n), user_id: "u1", status, title: `t${n}`, created_at: n });

function fakeConvex(answers: Record<string, any>) {
  const asked: string[] = [];
  return { asked, client: { query: async (_fn: any, args: { id: string }) => { asked.push(args.id); return answers[args.id] ?? null; } } as any };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("trigger feed keeps history", () => {
  beforeEach(() => {
    useInboxStore.setState({ agentTasks: {} } as any);
    useInboxStore.getState().syncTable("agentTasks", [row(1, "scheduled"), row(2, "scheduled"), row(3, "scheduled"), row(4, "completed")], { isDelta: true });
  });

  it("an armed row that finished outside the tail is kept, finished", async () => {
    const { client, asked } = fakeConvex({ [id(2)]: row(2, "completed") });
    verifyMissingArmed(client, [row(1, "scheduled"), row(3, "scheduled")]);
    await flush();
    const tasks = (useInboxStore.getState() as any).agentTasks;
    expect(asked).toEqual([id(2)]);
    expect(tasks[id(2)].status).toBe("completed");
    expect(tasks[id(4)].status).toBe("completed");
  });

  it("an armed row the server no longer has leaves the store; history stays", async () => {
    const { client } = fakeConvex({});
    verifyMissingArmed(client, [row(1, "scheduled"), row(2, "scheduled")]);
    await flush();
    const tasks = (useInboxStore.getState() as any).agentTasks;
    expect(tasks[id(3)]).toBeUndefined();
    expect(tasks[id(4)]).toBeDefined();
  });

  it("asks nothing when every armed row is in the answer", async () => {
    const { client, asked } = fakeConvex({});
    verifyMissingArmed(client, [row(1, "scheduled"), row(2, "scheduled"), row(3, "scheduled")]);
    await flush();
    expect(asked).toEqual([]);
  });
});
