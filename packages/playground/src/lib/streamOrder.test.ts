import { expect, test } from "bun:test";
import type { MessageView } from "../../convex/messages";
import { inLandingOrder } from "./streamOrder";

const chat = (id: string, at: number) => ({ id, created_at: at, build: null }) as unknown as MessageView;
const card = (id: string, at: number, status: string, finished: number | null) =>
  ({ id, created_at: at, build: { status, finished_at: finished } }) as unknown as MessageView;

test("a version sits where it went live; chat and unfinished cards where they were said", () => {
  const asked = card("asked early", 10, "live", 50);
  const restore = chat("restore note", 30);
  const said = chat("hi", 40);
  const building = card("next", 45, "building", null);
  expect(inLandingOrder([asked, restore, said, building, chat("later", 60)]).map((m) => m.id as string)).toEqual(["restore note", "hi", "next", "asked early", "later"]);
});

test("an ordered stream comes back as is", () => {
  const ms = [chat("a", 1), card("b", 2, "live", 3), chat("c", 4)];
  expect(inLandingOrder(ms)).toBe(ms);
});
