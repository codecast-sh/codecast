import { describe, expect, test } from "bun:test";
import { holdOwnerCard, ownerCardsKey, subscribeOwnerCards } from "../visibleOwnerCards";
import { coOwnersOf } from "../coOwners";

describe("the cards on screen whose owners the window reads", () => {
  test("the key is the held ids, sorted, and moves only when the set does", () => {
    let wakes = 0;
    const stop = subscribeOwnerCards(() => { wakes++; });
    const b = holdOwnerCard("b");
    const a = holdOwnerCard("a");
    const a2 = holdOwnerCard("a");
    expect(ownerCardsKey()).toBe("a,b");
    a2();
    expect(ownerCardsKey()).toBe("a,b");
    a();
    b();
    expect(ownerCardsKey()).toBe("");
    expect(wakes).toBe(4);
    stop();
  });

  test("a card under the model whose owners have not arrived shows no faces", () => {
    const s = { sessions: { x: { _id: "x", owners_model: true, owned_by_me: true, org_role_id: "r1" } }, sessionOwners: {} };
    expect(coOwnersOf(s as any, "x", "me", [])).toBeNull();
  });

  test("past 60 cards on screen, the 60 nearest the top are read, whatever order they were held in", () => {
    const id = (i: number) => `c${String(i).padStart(3, "0")}`;
    // Held top to bottom in reverse: card 0 is lowest on screen.
    const releases = Array.from({ length: 70 }, (_, i) => holdOwnerCard(id(i), 1_000 - i * 10));
    expect(ownerCardsKey().split(",")).toEqual(Array.from({ length: 60 }, (_, i) => id(i + 10)));
    for (const release of releases) release();
    expect(ownerCardsKey()).toBe("");
  });
});
