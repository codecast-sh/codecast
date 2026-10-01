import { describe, expect, test } from "bun:test";
import { insightSignalFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import { insightBlockerSignals, normalizeSignal } from "./signals";

describe("insightBlockerSignals", () => {
  test("each blocker is an insight bug signal keyed by session and text", () => {
    const out = insightBlockerSignals("jx7c6zk", ["Deploy fails on schema", "Tests time out"], undefined, "Ship the signals door");
    expect(out.map((s) => [s.source, s.kind, s.fingerprint, s.title, s.subject])).toEqual([
      ["insight", "bug", insightSignalFingerprint("jx7c6zk", "Deploy fails on schema"), "Deploy fails on schema", "jx7c6zk"],
      ["insight", "bug", insightSignalFingerprint("jx7c6zk", "Tests time out"), "Tests time out", "jx7c6zk"],
    ]);
    expect(out[0].detail_md).toContain("Ship the signals door");
    for (const s of out) expect(normalizeSignal(s)).toEqual(s);
  });

  test("a blocker the previous insight carried is not filed again, even restated", () => {
    const out = insightBlockerSignals("jx7c6zk", ["deploy fails on schema.", "New one"], ["Deploy fails on schema"], undefined);
    expect(out.map((s) => s.title)).toEqual(["New one"]);
  });

  test("duplicates and blanks inside one insight file once", () => {
    const out = insightBlockerSignals("jx7c6zk", ["Same", "same", "  "], [], undefined);
    expect(out).toHaveLength(1);
    expect(out[0].detail_md).not.toContain("working on");
  });
});
