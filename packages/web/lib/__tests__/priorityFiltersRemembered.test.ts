import { describe, expect, test } from "bun:test";
import { encodeFilters, withRemembered } from "../rememberedFilters";
import { FILTER_PARAMS, filterParams, readFilters, type ListFilters } from "../priorityList";

describe("priorities filters round-trip through the remembered copy", () => {
  test("a non-default choice comes back on a bare visit", () => {
    const chosen: ListFilters = { mine: false, hideDone: false, show: { sessions: true, plans: false, tasks: true, prs: false, branches: false, deploys: false } };
    const saved = new URLSearchParams(encodeFilters(filterParams(chosen)));
    expect(readFilters(withRemembered(new URLSearchParams(""), FILTER_PARAMS, saved))).toEqual(chosen);
  });

  test("going back to the defaults saves the defaults", () => {
    expect(encodeFilters(filterParams(readFilters(new URLSearchParams(""))))).toBe("");
  });
});
