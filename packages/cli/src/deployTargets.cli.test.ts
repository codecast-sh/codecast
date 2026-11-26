import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseManifest, parseManifestText } from "./workspace/manifest.js";
import { parseDeployTargetsText, readDeployTargets } from "./workspace/deployTargetsFile.js";
import { deploysFor, shipSpec } from "./land/shipCheckout.js";
import { awaitLive, targetDeployProfile, targetsOf } from "./lineDeploy.js";
import { shipPassBody } from "./land/shipCheckoutCli.js";
import { loadLineProfile } from "./lineProfile.js";
import { deployDuties, lineHeld } from "./workflow/awaitDeploy.js";

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
when = ["api/**"]
run = "deploy.sh"
stage = "before_push"
`;

const TARGETS = `
[[target]]
name = "backend"
ship = "convex"

[[target]]
name = "web"
runs = "push"
when = ["web/**"]
live = "github-status:acme - web"

[[target]]
name = "cli"
when = ["cli/**"]
run = "gh workflow run release.yml"
live = "json:https://dl.acme.dev/latest.json#sourceCommit,version"
rollback = "release.sh --back $sha"
`;

const REPO = path.resolve(import.meta.dir, "../../..");

function declared() {
  const ship = parseManifestText(MANIFEST)!.ship!;
  return parseDeployTargetsText(TARGETS, ship.deploy).map((e) => e.target);
}

describe("targets in .codecast/deploy.toml", () => {
  test("each [[target]] is one, a ship step's target takes the step's command and paths", () => {
    expect(targetsOf({ declared, line: () => null }).map((t) => [t.name, t.runs, t.live.kind, t.ship_stage, t.command ?? null])).toEqual([
      ["backend", "here", "marker", "before_push", "deploy.sh"],
      ["web", "push", "github-status", "press", null],
      ["cli", "here", "json", "press", "gh workflow run release.yml"],
    ]);
  });

  test("a ship runs its steps, and the step a target names carries that target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-targets-"));
    fs.mkdirSync(path.join(root, ".codecast"));
    fs.writeFileSync(path.join(root, ".codecast/workspace.toml"), MANIFEST);
    fs.writeFileSync(path.join(root, ".codecast/deploy.toml"), TARGETS);
    const spec = shipSpec(root);
    expect(deploysFor(spec.deploy, ["api/x.ts", "cli/y.ts", "web/z.tsx"]).map((s) => [s.name, s.target ?? null])).toEqual([["typing-guard", null], ["convex", "backend"]]);
    fs.writeFileSync(path.join(root, ".codecast/deploy.toml"), "[[target]]\nname = 1\n");
    expect(shipSpec(root).deploy.map((s) => s.target ?? null)).toEqual([null, null]);
    fs.rmSync(root, { recursive: true });
  });

  test("a bad target is refused naming the file and its table", () => {
    expect(() => parseDeployTargetsText(`[[target]]\nname = "x"\nrun = "a"\nlive = "ping"\n`, [])).toThrow(/deploy.toml: target\[0\]: live "ping"/);
    expect(() => parseDeployTargetsText(`[[target]]\nname = "x"\n`, [])).toThrow(/needs run/);
  });

  test("workspace.toml keeps the [[ship.deploy]] schema every released CLI reads", () => {
    expect(() => parseManifestText(`[ship]\n[[ship.deploy]]\nrun = "a"\ntarget = "x"\n`)).toThrow(/unknown key in \[\[ship.deploy\]\]: 'target'/);
    expect(() => parseManifestText(`[ship]\n[[ship.deploy]]\nrun = "a"\nstage = "press"\n`)).toThrow(/stage/);
  });

  test("codecast's own files declare its five targets, and a ship sends only the backend", () => {
    const m = parseManifest(path.join(REPO, ".codecast/workspace.toml"))!;
    const targets = readDeployTargets(REPO, m.ship!.deploy);
    expect(targets.map((t) => t.name)).toEqual(["backend", "web", "cli", "mobile", "desktop"]);
    expect(deploysFor(shipSpec(REPO).deploy, ["packages/cli/src/index.ts", "packages/mobile/app.tsx", "packages/convex/convex/x.ts"]).map((s) => [s.name, s.target ?? null])).toEqual([["convex", "backend"]]);
  });

  test("codecast's change runs send every target a change touches: backend at Merge (Deploy only waits on it), cli and mobile, web on push; desktop waits for a press", () => {
    const spec = shipSpec(REPO);
    expect(spec.flow).toBe("change");
    const files = ["packages/convex/convex/x.ts", "packages/web/app/page.tsx", "packages/cli/src/index.ts", "packages/mobile/app.tsx", "packages/electron/main.js"];
    // Merge runs these from the rebased change before it merges (workflow/mergeStation.ts mainSteps).
    expect(deploysFor(spec.deploy.filter((s) => s.stage === "before_push"), files).map((s) => s.name)).toEqual(["typing-guard", "convex"]);
    const held = lineHeld(loadLineProfile(REPO).profile.deploy);
    expect(held).toEqual({});
    const { duties } = deployDuties(readDeployTargets(REPO, spec.deploy), files, { held });
    expect(duties.map((d) => [d.target, d.action, d.how])).toEqual([
      ["backend", "wait", "merge"],
      ["web", "wait", "push"],
      ["cli", "send", "release"],
      ["mobile", "send", "release"],
      ["desktop", "wait", "others"],
    ]);
  });
});

describe("running a target's deploy", () => {
  test("the send is the target's command, or its rollback; a target read from elsewhere waits for its reader", () => {
    const [backend, , cli] = targetsOf({ declared, line: () => null });
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

  test("a deploy step's push carries what it changed and when its diff read prod, only when the diff ran", () => {
    const outcome: any = {
      ok: true, stage: "done", commits: [], held: [],
      deploys: [
        { name: "convex", stage: "before_push", ok: true, target: "backend", machine: "box", via: "deploy.sh", adds: ["fn:a:b"], drops: [], changes_read_at: 1234, pushed_at: Date.now() - 60_000 },
        { name: "convex2", stage: "before_push", ok: true, target: "backend", machine: "box", via: "deploy.sh", changes_read_at: 1234 },
      ],
    };
    const body: any = shipPassBody({ groups: [] } as any, outcome, "acme/app", 1, "dev1");
    expect(body.deploys[0]).toMatchObject({ name: "convex", stage: "before_push", ok: true, target: "backend", machine: "box", via: "deploy.sh", adds: ["fn:a:b"], drops: [] });
    // Sent as an age (the read at 1234 is long ago by now), dated by the server's clock.
    expect(body.deploys[0].changes_read_age_ms).toBeGreaterThan(0);
    expect(body.deploys[0]).not.toHaveProperty("changes_read_at");
    expect(body.deploys[1]).not.toHaveProperty("changes_read_age_ms");
    // When the step pushed, as an age: about a minute ago here.
    expect(body.deploys[0].pushed_age_ms).toBeGreaterThanOrEqual(60_000);
    expect(body.deploys[0]).not.toHaveProperty("pushed_at");
  });
});
