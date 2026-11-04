import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { parseManifest, parseManifestText } from "./workspace/manifest.js";
import { deploysFor } from "./land/shipCheckout.js";
import { awaitLive, targetDeployProfile, targetsOf } from "./lineDeploy.js";
import { shipPassBody } from "./land/shipCheckoutCli.js";

// A repository's deploy targets as the CLI reads them (docs/architecture/deploys.md DP10 to DP13).

const MANIFEST = `
[ship]
mode = "direct"

[[ship.deploy]]
name = "typing-guard"
when = ["web/**"]
run = "guard.sh"
stage = "before_push"

[[ship.deploy]]
name = "convex"
target = "backend"
when = ["api/**"]
run = "deploy.sh"
stage = "before_push"

[[ship.deploy]]
target = "web"
runs = "push"
when = ["web/**"]
live = "github-status:acme - web"

[[ship.deploy]]
target = "cli"
when = ["cli/**"]
run = "gh workflow run release.yml"
stage = "press"
live = "json:https://dl.acme.dev/latest.json#sourceCommit,version"
rollback = "release.sh --back $sha"
`;

describe("targets in [[ship.deploy]]", () => {
  test("entries that name a target are the repository's targets; a gate is not", () => {
    const ship = parseManifestText(MANIFEST)!.ship!;
    const targets = targetsOf("/repo", { ship: () => ship.deploy, line: () => null });
    expect(targets.map((t) => [t.name, t.runs, t.live.kind, t.ship_stage])).toEqual([
      ["backend", "here", "marker", "before_push"],
      ["web", "push", "github-status", "press"],
      ["cli", "here", "json", "press"],
    ]);
  });

  test("a ship runs the gate and the backend, never a press target or one that deploys on push", () => {
    const ship = parseManifestText(MANIFEST)!.ship!;
    expect(deploysFor(ship.deploy, ["api/x.ts", "cli/y.ts", "web/z.tsx"]).map((s) => s.name)).toEqual(["typing-guard", "convex"]);
  });

  test("a bad target is refused by its entry", () => {
    expect(() => parseManifestText(`[ship]\n[[ship.deploy]]\ntarget = "x"\nrun = "a"\nlive = "ping"\n`)).toThrow(/ship.deploy\[0\]: live "ping"/);
    expect(() => parseManifestText(`[ship]\n[[ship.deploy]]\ntarget = "x"\n`)).toThrow(/run/);
    expect(() => parseManifestText(`[ship]\n[[ship.deploy]]\nrun = "a"\ncolour = "red"\n`)).toThrow(/unknown key/);
  });

  test("codecast's own manifest declares its five targets", () => {
    const m = parseManifest(path.resolve(import.meta.dir, "../../../.codecast/workspace.toml"))!;
    const targets = targetsOf("/repo", { ship: () => m.ship!.deploy, line: () => null });
    expect(targets.map((t) => t.name)).toEqual(["backend", "web", "cli", "mobile", "desktop"]);
    expect(deploysFor(m.ship!.deploy, ["packages/cli/src/index.ts", "packages/mobile/app.tsx"]).map((s) => s.name)).toEqual([]);
  });
});

describe("running a target's deploy", () => {
  test("the send is the target's command, or its rollback; a target read from elsewhere waits for its reader", () => {
    const ship = parseManifestText(MANIFEST)!.ship!;
    const [backend, , cli] = targetsOf("/repo", { ship: () => ship.deploy, line: () => null });
    expect(targetDeployProfile(backend, "deploy")).toEqual({ command: "deploy.sh", target: "backend", trigger: "person" });
    expect(targetDeployProfile(cli, "rollback")).toMatchObject({ command: "release.sh --back $sha", live: "cast line deploy await-live $deploy" });
  });

  test("await-live passes once the deploy is recorded live, fails when it failed", async () => {
    const states = ["running", "running", "live"];
    const read = async () => ({ status: states.shift(), sha: "abcdef1234" });
    expect(await awaitLive({ deploy: "dp-1", read, sleep: async () => {}, log: () => {} })).toBe(0);
    expect(await awaitLive({ deploy: "dp-1", read: async () => ({ status: "failed" }), sleep: async () => {}, log: () => {} })).toBe(1);
  });
});

describe("a ship pass as codecast records it", () => {
  test("each commit names its session, held groups count their files, target steps keep their target", () => {
    const plan: any = { groups: [{ id: "s:jx7abcd", session: { id: "jx7abcd", conversation_id: "conv1" } }, { id: "unattributed", session: null }] };
    const outcome: any = {
      ok: true, stage: "done", base: "b".repeat(40), tip: "c".repeat(40), pushed: "d".repeat(40),
      commits: [{ sha: "d".repeat(40), message: "feat: x", group: "s:jx7abcd", files: 3 }, { sha: "e".repeat(40), message: "chore", group: "unattributed", files: 1 }],
      held: [{ group: "s:other", paths: ["a", "b"], note: "mid-turn" }],
      deploys: [{ name: "convex", stage: "before_push", ok: true, target: "backend", dirty: 2 }],
    };
    const body: any = shipPassBody(plan, outcome, "acme/app", 1, "dev1");
    expect(body.commits).toEqual([
      { sha: "d".repeat(40), message: "feat: x", files: 3, session_id: "jx7abcd", conversation_id: "conv1" },
      { sha: "e".repeat(40), message: "chore", files: 1 },
    ]);
    expect(body.held).toEqual([{ group: "s:other", paths: 2, note: "mid-turn" }]);
    expect(body.deploys).toEqual([{ name: "convex", stage: "before_push", ok: true, target: "backend", dirty: 2 }]);
    expect(body).toMatchObject({ repository: "acme/app", pushed: "d".repeat(40), device_id: "dev1" });
  });
});
