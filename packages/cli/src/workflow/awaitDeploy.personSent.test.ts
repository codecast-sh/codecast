// A team whose production deploy a person sends: its change flow composes the
// deploy segment with `send=""`, and its production target is
// `policy = "release"` sent by a person ([line.deploy] trigger = "person"). A
// change run there must never send production, whatever either guard alone
// says. The fixture is synthetic, in that shape.
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { checkoutTargets } from "../lineDeploy";
import { loadLineProfile } from "../lineProfile";
import { awaitDeploy, deployDuties, lineHeld } from "./awaitDeploy";
import { parseWorkflowFile } from "./parser";

const root = path.join(import.meta.dir, "__fixtures__", "person-sent-deploy");
const apiChange = ["api/src/handler.ts"];

describe("a change run never sends a target a person sends", () => {
  test("a flow that composes Deploy with send empty sends nothing", async () => {
    const graph = parseWorkflowFile(path.join(root, "line", "change.cast"));
    const script = graph.nodes.get("deploy__wait")!.script!;
    expect(script).toContain(`--send ""`);
    const { duties } = deployDuties(await checkoutTargets(root), apiChange, { held: lineHeld(loadLineProfile(root).profile.deploy), send: false });
    expect(duties.filter((d) => d.action === "send")).toEqual([]);
    // The run waits for the person to send it: Live means production carries the change.
    expect(duties).toEqual([expect.objectContaining({ target: "production", action: "wait", how: "others", by: "a person" })]);
  });

  test("codecast's own targets: a shared change never sends mobile before the backend it calls is live with the change", async () => {
    // Read from this checkout, so the test follows codecast's deploy.toml and line.toml as they change.
    const repo = path.resolve(import.meta.dir, "../../../..");
    const plan = deployDuties(await checkoutTargets(repo), ["packages/shared/contracts/example.ts"], { held: lineHeld(loadLineProfile(repo).profile.deploy) });
    const mobile = plan.duties.find((d) => d.target === "mobile");
    expect(mobile?.after).toContain("backend");
    const sha = "1a2b3c4d5e6f7a8b9c0d";
    const run = async (backendLiveAt: number) => {
      let tick = 0;
      const sends: Array<{ targets: string[]; tick: number }> = [];
      await awaitDeploy({ sha, base: "main", plan, intervalMs: 60_000 }, {
        now: () => tick * 60_000,
        sleep: async () => { tick++; },
        mainHead: async () => sha,
        // The backend's deploy carries the change from `backendLiveAt` (the Merge station's pre-merge deploy records it
        // live at the landed sha); every other target goes live the poll after it is sent.
        targets: async () => plan.duties.map((d) => d.target).concat("backend").map((name) => ({
          name,
          history: name === "backend"
            ? (tick >= backendLiveAt ? [{ short_id: "dp-1", status: "live", sha, created_at: 1 }] : [])
            : sends.some((s) => s.targets.includes(name) && s.tick < tick) ? [{ short_id: `dp-${name}`, status: "live", sha, created_at: 2 }] : [],
        })),
        carries: async (deployed) => deployed === sha,
        mainCi: async () => ({ state: "passed", red: [] }),
        redSince: async () => null,
        send: async (targets) => { sends.push({ targets, tick }); return new Promise(() => {}); },
        progress: () => {},
        block: async () => {},
        clock: { load: () => null, save: () => {} },
      });
      return sends;
    };
    // Whether the run sends backend itself (in the same `cast deploy`, which orders them) or a person or the Merge
    // station does, mobile goes no earlier than backend.
    for (const at of [0, 4]) {
      const sends = await run(at);
      const mobileSent = sends.find((s) => s.targets.includes("mobile"))!;
      expect(mobileSent.targets.includes("backend") || mobileSent.tick >= at).toBe(true);
    }
  });

  // A backend a person sends ([line.deploy]): mobile goes after it.
  test("codecast's own targets: mobile behind a person-sent backend is still waiting at minute 61, not stuck", async () => {
    const repo = path.resolve(import.meta.dir, "../../../..");
    const plan = deployDuties(await checkoutTargets(repo), ["packages/shared/contracts/example.ts"], { held: lineHeld(loadLineProfile(repo).profile.deploy) });
    const backend = plan.duties.find((d) => d.target === "backend");
    // Codecast's backend is now sent by Merge before the merge (how "merge", awaitDeploy.test.ts covers it); this
    // test is about a person-sent backend, so it holds only while one is declared.
    if (backend?.action !== "wait" || backend.how !== "others") return;
    let tick = 0;
    const lines: string[] = [];
    const r = await awaitDeploy({ sha: "1a2b3c4d5e6f7a8b9c0d", base: "main", plan, intervalMs: 60_000, once: false }, {
      now: () => tick * 60_000,
      sleep: async () => { tick++; if (tick > 61) throw new Error("stop"); },
      mainHead: async () => "1a2b3c4d5e6f7a8b9c0d",
      // Every other target the change touches is live with it; only the person's backend and mobile behind it wait.
      targets: async () => plan.duties.map((d) => ({ name: d.target, history: ["backend", "mobile"].includes(d.target) ? [] : [{ short_id: `dp-${d.target}`, status: "live", sha: "1a2b3c4d5e6f7a8b9c0d", created_at: 1 }] })),
      carries: async (deployed) => deployed === "1a2b3c4d5e6f7a8b9c0d",
      mainCi: async () => ({ state: "passed", red: [] }),
      redSince: async () => null,
      send: async () => new Promise(() => {}),
      progress: (l) => lines.push(l),
      block: async () => {},
      clock: { load: () => null, save: () => {} },
    }).catch((e: Error) => ({ code: -1, line: e.message }));
    expect(r).toEqual({ code: -1, line: "stop" });
    const at61 = lines.filter((l) => l.includes("mobile:")).pop()!;
    expect(at61).toContain("mobile: held until backend is live with 1a2b3c4 (held 61m, then 60m)");
  });

  test("even a flow that sends release targets only waits for the person who presses Deploy on production", async () => {
    const { duties } = deployDuties(await checkoutTargets(root), apiChange, { held: lineHeld(loadLineProfile(root).profile.deploy), send: true });
    expect(duties).toEqual([expect.objectContaining({ target: "production", action: "wait", how: "others", by: "a person" })]);
  });
});
