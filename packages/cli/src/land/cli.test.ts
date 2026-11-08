// `cast land scan --verdict`: only the named verdicts' trees, on this machine and every host.
import { describe, expect, test } from "bun:test";
import { keepVerdicts, type LandScan } from "./cli.js";

const tree = (path: string, verdict: string) => ({ path, verdict }) as unknown as LandScan["repos"][number]["trees"][number];
const scan = (trees: ReturnType<typeof tree>[]): LandScan => ({
  scannedAt: "", machine: "m", roster: "ok",
  repos: [{ repo: "r", root: "/r", origin: "", mainRef: "origin/main", trees, errors: [] }],
});

describe("keepVerdicts", () => {
  test("keeps only the named verdicts, inside each host's result too, and leaves a host error alone", () => {
    const s: LandScan = {
      ...scan([tree("/a", "ready"), tree("/b", "stale"), tree("/c", "review")]),
      hosts: [{ id: "h1", label: "u@h1", result: scan([tree("/d", "landed"), tree("/e", "ready")]) }, { id: "h2", label: "u@h2", error: "no answer in 5 min" }],
    };
    const kept = keepVerdicts(s, new Set(["ready", "review"]));
    expect(kept.repos[0]!.trees.map((t) => t.path)).toEqual(["/a", "/c"]);
    expect(kept.hosts![0]!.result!.repos[0]!.trees.map((t) => t.path)).toEqual(["/e"]);
    expect(kept.hosts![1]).toEqual({ id: "h2", label: "u@h2", error: "no answer in 5 min" });
    expect(s.repos[0]!.trees).toHaveLength(3);
  });
});
