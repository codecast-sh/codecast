import { describe, expect, it } from "bun:test";
import { glueUnits, plural } from "../format";

const NB = "\u00a0";

describe("glueUnits", () => {
  it("holds a number to its unit with a no-break space", () => {
    expect(glueUnits("cold start fell from 900 ms to 40 ms")).toBe(`cold start fell from 900${NB}ms to 40${NB}ms`);
    expect(glueUnits("2.1 MB smaller, 3 GB and 12 KB")).toBe(`2.1${NB}MB smaller, 3${NB}GB and 12${NB}KB`);
    expect(glueUnits("4 x faster, 30 % less, 5 min, 2 h, 3 seconds, 10 minutes, 1 s.")).toBe(
      `4${NB}x faster, 30${NB}% less, 5${NB}min, 2${NB}h, 3${NB}seconds, 10${NB}minutes, 1${NB}s.`,
    );
  });

  it("leaves words that only start like a unit alone", () => {
    expect(glueUnits("3 sessions over 2 hosts, 4 xterms, 5 minimal fixes")).toBe("3 sessions over 2 hosts, 4 xterms, 5 minimal fixes");
    expect(glueUnits("no numbers here")).toBe("no numbers here");
  });
});

describe("plural", () => {
  it("names one and many", () => {
    expect(plural(1, "commit")).toBe("1 commit");
    expect(plural(1204, "story", "stories")).toBe("1,204 stories");
  });
});
