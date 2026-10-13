import { describe, expect, test } from "bun:test";
import { fitPeopleRow } from "../peopleRowFit";

describe("fitPeopleRow", () => {
  test("everything fits: no overflow", () => {
    expect(fitPeopleRow([50, 50, 50], 170, 6, 40)).toEqual([0, 1, 2]);
  });

  test("overflow leaves room for the more pill", () => {
    // 50 + 6 + 50 + 6 + 40 = 152 fits; a third pill would need 208
    expect(fitPeopleRow([50, 50, 50, 50], 160, 6, 40)).toEqual([0, 1]);
  });

  test("selected person past the fold takes a visible slot", () => {
    expect(fitPeopleRow([50, 50, 50, 50], 160, 6, 40, 3)).toEqual([0, 3]);
  });

  test("nothing fits: everyone goes to the menu", () => {
    expect(fitPeopleRow([200, 200], 100, 6, 40)).toEqual([]);
  });
});
