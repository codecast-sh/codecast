import { describe, expect, test } from "bun:test";
import { linkArrival } from "./linkArrival";

/** A mounted screen over time: its route's param, what it has seen, its filter. */
function screen() {
  let param: string | null = null;
  let seen: string | null = null;
  let filter = "";
  const render = () => {
    // Render until the address settles, as the screen does: apply, then consume.
    for (let i = 0; i < 4; i++) {
      const step = linkArrival(param, seen);
      seen = step.seen;
      if (step.apply) filter = step.apply;
      if (!step.consume) return;
      param = null;
    }
  };
  return {
    link(id: string) { param = id; render(); },
    clearFilter() { filter = ""; render(); },
    pick(id: string) { filter = id; render(); },
    get filter() { return filter; },
    get param() { return param; },
  };
}

describe("a link's param on a screen that stays mounted", () => {
  test("applies on arrival and leaves the address", () => {
    const s = screen();
    s.link("sarah");
    expect(s.filter).toBe("sarah");
    expect(s.param).toBeNull();
  });

  test("the same link applies again after the filter was cleared", () => {
    const s = screen();
    s.link("sarah");
    s.clearFilter();
    expect(s.filter).toBe("");
    s.link("sarah");
    expect(s.filter).toBe("sarah");
  });

  test("the same link applies again after another filter was picked", () => {
    const s = screen();
    s.link("sarah");
    s.pick("omar");
    s.link("sarah");
    expect(s.filter).toBe("sarah");
  });

  test("another person's link replaces the first", () => {
    const s = screen();
    s.link("sarah");
    s.link("omar");
    expect(s.filter).toBe("omar");
  });

  test("no param applies nothing and asks for nothing", () => {
    expect(linkArrival(undefined, null)).toEqual({ apply: null, seen: null, consume: false });
    expect(linkArrival(null, "sarah")).toEqual({ apply: null, seen: null, consume: false });
  });

  test("a param still on the address is not applied twice while it waits to be consumed", () => {
    expect(linkArrival("sarah", null)).toEqual({ apply: "sarah", seen: "sarah", consume: true });
    expect(linkArrival("sarah", "sarah")).toEqual({ apply: null, seen: "sarah", consume: true });
  });
});
