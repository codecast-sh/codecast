import { expect, test } from "bun:test";
import { callPeople, earlierCallsWith, peopleKey } from "../callPeople";

const call = (id: string, room_key: string, ids: string[], at = 1000, over: Record<string, unknown> = {}) => ({
  _id: id,
  room_key,
  started_at: at,
  started_by: ids[0] ?? "u-me",
  participants: ids.map((p) => ({ id: p, name: p })),
  ...over,
});

test("a call's people are whoever spoke, whoever started it, and the people a people room was opened for", () => {
  // Ann never spoke, but a 1:1 is between both of us.
  expect(callPeople(call("a", "dm:u-ann:u-me", ["u-me"]))).toEqual(["u-ann", "u-me"]);
  // Agents and guests are not who a call is between.
  expect(callPeople(call("b", "session:conv_1", ["u-me", "agent:conv_2", "guest:g123"]))).toEqual(["u-me"]);
  // A third person rung into a 1:1 makes it the three people's call.
  expect(callPeople(call("c", "dm:u-ann:u-me", ["u-bo"]))).toEqual(["u-ann", "u-bo", "u-me"]);
});

test("earlier calls match on the exact set of people, newest first, never the current call, a recording or a later call", () => {
  const calls = [
    call("now", "dm:u-ann:u-me", ["u-me", "u-ann"], 5000),
    call("later", "dm:u-ann:u-me", ["u-me"], 9000),
    call("group", "dm:u-ann:u-me", ["u-me", "u-ann", "u-bo"], 4000),
    call("ch", "channel:c1", ["u-me", "u-ann"], 3000),
    call("rec", "rec:abcdef12-3456", ["u-me"], 2500),
    call("screen", "session:conv_1", ["u-me", "u-ann"], 2000, { screen: { width: 1 } }),
    call("one", "dm:u-ann:u-me", ["u-ann"], 1000),
  ];
  const key = peopleKey(["u-me", "u-ann", "agent:conv_x"]);
  expect(earlierCallsWith(calls, key, { exclude: "now", before: 5000, limit: 10 }).map((c) => c._id)).toEqual(["ch", "one"]);
  expect(earlierCallsWith(calls, peopleKey(["u-me", "u-ann", "u-bo"]), { limit: 10 }).map((c) => c._id)).toEqual(["group"]);
  // Alone in a room is nobody's conversation history.
  expect(earlierCallsWith(calls, peopleKey(["u-me"]), { limit: 10 })).toEqual([]);
});
