import { describe, expect, it } from "bun:test";
import { parseDecideOption } from "./decideCommand.js";

describe("cast decide option parsing", () => {
  it("keeps a bare label as a label", () => {
    expect(parseDecideOption("Approve")).toEqual({ label: "Approve" });
  });

  it("splits 'label :: what happens' into label and consequence", () => {
    expect(parseDecideOption("Approve :: frees the last migration")).toEqual({
      label: "Approve",
      description: "frees the last migration",
    });
  });

  it("tolerates missing spaces around the separator", () => {
    expect(parseDecideOption("Path wins::stable across edits")).toEqual({
      label: "Path wins",
      description: "stable across edits",
    });
  });

  it("ignores a trailing separator with no consequence after it", () => {
    expect(parseDecideOption("Hold ::")).toEqual({ label: "Hold" });
  });

  it("only splits on the FIRST separator, so a consequence may contain one", () => {
    expect(parseDecideOption("Ship :: a :: b")).toEqual({
      label: "Ship",
      description: "a :: b",
    });
  });
});
