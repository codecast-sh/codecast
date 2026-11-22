import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { runDeployStep } from "./shipCheckout";

// A deploy step can say what its push did to its target; the ship carries
// that onto the deploy it records (packages/convex/deploy.sh writes it).

describe("a ship's deploy step", () => {
  test("a step that writes its changes reports them with this machine", async () => {
    let seen = "";
    const r = await runDeployStep(async (env) => {
      seen = env.CAST_PUSH_CHANGES_FILE!;
      fs.writeFileSync(seen, JSON.stringify({ adds: ["fn:a:b"], drops: ["index:voiceprints.by_user", 3], tree_ms: 1 }));
      return { code: 0, output: "" };
    });
    expect(r.changes).toEqual({ machine: os.hostname(), via: "deploy.sh", adds: ["fn:a:b"], drops: ["index:voiceprints.by_user"] });
    // The file is the step's to fill and the ship's to clean up.
    expect(fs.existsSync(seen)).toBe(false);
  });

  test("a step that writes nothing reports nothing", async () => {
    const r = await runDeployStep(async () => ({ code: 0, output: "ok" }));
    expect(r).toEqual({ code: 0, output: "ok", changes: {} });
  });

  test("garbage in the file reports nothing rather than failing the ship", async () => {
    const r = await runDeployStep(async (env) => { fs.writeFileSync(env.CAST_PUSH_CHANGES_FILE!, "{not json"); return { code: 0, output: "" }; });
    expect(r.changes).toEqual({});
  });
});
