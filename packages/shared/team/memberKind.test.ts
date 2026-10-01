import { describe, expect, test } from "bun:test";
import { isPerson, memberKind, peopleOf } from "./memberKind";

const person = { _id: "p", name: "Ada" };
const slack = { _id: "s", name: "Union (Slack)", is_bot: true, bot_kind: "slack" };
const role = { _id: "r", name: "Infra lead", is_bot: true, bot_kind: "role" };
const anchor = { _id: "a", name: "Anchor", is_bot: true, bot_kind: "anchor" };
const account = { _id: "b", name: "Aivery", is_bot: true };

describe("memberKind", () => {
  test("classifies every roster identity", () => {
    expect([person, slack, role, anchor, account].map(memberKind)).toEqual(["person", "slack", "agent", "agent", "agent"]);
  });
  test("people lists keep humans only and drop nulls", () => {
    expect(peopleOf([person, null, slack, role, anchor, account, undefined])).toEqual([person]);
    expect(isPerson(null)).toBe(false);
    expect(peopleOf(undefined)).toEqual([]);
  });
});
