import { describe, expect, test } from "bun:test";
import { ParityLedger, parityKey, renderParityText } from "./parity";

describe("parity ledger", () => {
  test("an item no step reported on ends as a failure, never as silence", () => {
    const l = new ParityLedger();
    l.plan("repo", "~/src/a");
    l.plan("tool", "uv");
    l.settle(parityKey("repo", "~/src/a"), "carried");
    const r = l.finish({ laptop: "mac", target: "i-1" });
    expect(r.items.find((i) => i.name === "uv")).toMatchObject({ status: "failed", reason: "no step reported what happened to it" });
    expect(r.counts).toMatchObject({ carried: 1, failed: 1, planned: 0 });
  });

  test("a dry run keeps planned items as planned", () => {
    const l = new ParityLedger();
    l.plan("repo", "~/src/a");
    expect(l.finish({ laptop: "mac", target: "dry run", dryRun: true }).counts.planned).toBe(1);
  });

  test("skipped and failed items need a reason", () => {
    const l = new ParityLedger();
    expect(() => l.skip("tool", "x", " ")).toThrow(/without a reason/);
    const k = l.plan("tool", "y");
    expect(() => l.settle(k, "failed")).toThrow(/without a reason/);
  });

  test("an outcome for an item the inventory never planned is still recorded", () => {
    const l = new ParityLedger();
    l.settle(parityKey("tool", "jq"), "installed");
    expect(l.get("tool:jq")).toMatchObject({ area: "tool", name: "jq", status: "installed" });
  });

  test("a later success clears an earlier reason", () => {
    const l = new ParityLedger();
    const k = l.plan("login", "gh");
    l.settle(k, "failed", { reason: "first try" });
    l.settle(k, "carried");
    expect(l.get(k)?.reason).toBeUndefined();
  });

  test("the text report names every item that did not make it, with its reason and fix", () => {
    const l = new ParityLedger();
    for (let i = 0; i < 30; i++) l.skip("service", `svc${i}`, `reason ${i}`, { fix: `fix ${i}` });
    l.plan("repo", "~/src/a");
    const text = renderParityText(l.finish({ laptop: "mac", target: "i-1" }));
    for (let i = 0; i < 30; i++) {
      expect(text).toContain(`svc${i}: reason ${i}`);
      expect(text).toContain(`fix: fix ${i}`);
    }
    expect(text).toContain("FAILED");
  });

  test("grouped paths are capped in the terminal with a count, and all listed with --all", () => {
    const l = new ParityLedger();
    l.skip("files", "~/src/a: media", "stays", { paths: Array.from({ length: 20 }, (_, i) => `p${i}.mp4`) });
    const r = l.finish({ laptop: "mac", target: "i-1" });
    expect(renderParityText(r)).toContain("and 12 more");
    const all = renderParityText(r, { all: true });
    for (let i = 0; i < 20; i++) expect(all).toContain(`p${i}.mp4`);
  });
});
