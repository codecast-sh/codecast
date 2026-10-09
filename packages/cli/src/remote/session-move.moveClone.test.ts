import { describe, expect, test } from "bun:test";
import { checkoutOfMoveClone, moveClonePath } from "./session-move.js";

describe("move clones belong to the host checkout they stand in for", () => {
  const main = "/home/ashot/src/codecast";
  const clone = moveClonePath(main, "mg-33c6a58e9f");
  const only = (...dirs: string[]) => (p: string) => dirs.includes(p);

  test("the clone lands beside the checkout", () => {
    expect(clone).toBe("/home/ashot/src/codecast-mv-33c6a58e");
  });

  test("a move clone's root is the checkout, so the project is named by it", () => {
    expect(checkoutOfMoveClone(clone, only(main))).toBe(main);
  });

  test("a clone whose checkout is gone keeps its own root", () => {
    expect(checkoutOfMoveClone(clone, only())).toBe(clone);
  });

  test("any other folder is its own root", () => {
    expect(checkoutOfMoveClone(main, only(main))).toBe(main);
    expect(checkoutOfMoveClone("/home/ashot/src/codecast-v2", only(main))).toBe("/home/ashot/src/codecast-v2");
  });
});
