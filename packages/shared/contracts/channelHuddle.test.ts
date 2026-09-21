import { expect, test } from "bun:test";
import { channelHuddleMemberIds, CHANNEL_HUDDLE_WARNING_SIZE } from "./callRoomKeys";

test("counts human channel members including the caller, with a warning above seven", () => {
  const members = Array.from({ length: 8 }, (_, i) => ({ _id: `u${i}` }));
  expect(channelHuddleMemberIds("public", undefined, members.slice(0, 7))!.length > CHANNEL_HUDDLE_WARNING_SIZE).toBe(false);
  expect(channelHuddleMemberIds("public", undefined, members)!.length > CHANNEL_HUDDLE_WARNING_SIZE).toBe(true);
  expect(channelHuddleMemberIds("private", ["u0", "u1", "departed"], [...members, { _id: "bot", is_bot: true }])).toEqual(["u0", "u1"]);
  expect(channelHuddleMemberIds("public", undefined, [...members, members[0], { _id: "bot", is_bot: true }])).toHaveLength(8);
});

test("a missing roster stays unknown and community channels have no audience", () => {
  expect(channelHuddleMemberIds("private", undefined, [{ _id: "u0" }])).toBeUndefined();
  expect(channelHuddleMemberIds("public", undefined, [])).toBeUndefined();
  expect(channelHuddleMemberIds("community", undefined, [{ _id: "u0" }])).toEqual([]);
});
