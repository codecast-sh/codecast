import { describe, expect, test } from "bun:test";
import { sourceLedger } from "./ProjectSources";

describe("sourceLedger", () => {
  test("a channel source names where its runs land and what each run reads", () => {
    const l = sourceLedger({ source: "#intake", project: "Sources test", mainSession: "Main", channel: true });
    expect(l.shift).toBeNull();
    expect(l.confirm).toBe("Watch #intake");
    expect(l.rows.map((r) => r.k)).toEqual(["Watches", "Runs in", "A run gets", "Skips", "Paused"]);
    expect(l.rows.find((r) => r.k === "Runs in")!.v).toBe("Main");
  });

  test("with no main session the review says one is started", () => {
    const l = sourceLedger({ source: "PR opened", project: "P", mainSession: null, channel: false });
    expect(l.rows.find((r) => r.k === "Runs in")!.v).toBe("New main session");
    expect(l.rows.some((r) => r.k === "Skips")).toBe(false);
  });
});
