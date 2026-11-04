// The phone's trigger feed: every armed trigger and only the most recent
// finished ones, never a busy account's whole history.
import { expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { armedAndRecentlyFinished } from "./agentTasks";

const USER = "user_1" as any;
const row = (n: number, status: string, user = USER) => ({ _id: `t${n}`, _creationTime: n, user_id: user, status, retry_count: 0 });

test("returns every armed trigger and the newest finished ones up to the limit", async () => {
  const rows = [
    row(1, "completed"), row(2, "failed"), row(3, "scheduled"), row(4, "completed"),
    row(5, "cancelled"), row(6, "paused"), row(7, "completed"), row(8, "running"),
    row(9, "scheduled", "user_2"), row(10, "completed", "user_2"),
  ];
  const db = makeFakeDb({ agent_tasks: rows }, { indexes: schemaIndexes(schema) });
  const ids = (await armedAndRecentlyFinished({ db }, USER, 3)).map((t: any) => t._id);
  expect(ids.slice(0, 3).sort()).toEqual(["t3", "t6", "t8"]);
  expect(ids.slice(3)).toEqual(["t7", "t5", "t4"]);
});

test("a zero limit returns only the armed triggers", async () => {
  const db = makeFakeDb({ agent_tasks: [row(1, "completed"), row(2, "scheduled")] }, { indexes: schemaIndexes(schema) });
  expect((await armedAndRecentlyFinished({ db }, USER, 0)).map((t: any) => t._id)).toEqual(["t2"]);
});
