import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { graphSlug, namedFlows, writeSessionFlow, SESSION_FLOWS_DIR } from "./sessionFlow";
import { parseWorkflowFile, emptySlots } from "./parser";

const BACKBONE = `digraph spine {
  graph [kind="line", label="Spine"]
  start [shape=Mdiamond]
  exit [shape=Msquare]
  investigate [prompt="@spine/investigate.md"]
  implement [slot="Make the change"]
  start -> investigate -> implement -> exit
}`;

function checkout() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-flow-")));
  spawnSync("git", ["init", "-q"], { cwd: top });
  // A published flow as this machine keeps it: outside the checkout, its station file beside it.
  const lib = path.join(top, "..", `${path.basename(top)}-lib`);
  fs.mkdirSync(path.join(lib, "spine"), { recursive: true });
  fs.writeFileSync(path.join(lib, "spine.cast"), BACKBONE);
  fs.writeFileSync(path.join(lib, "spine", "investigate.md"), "Find the cause.");
  return { top, pool: [{ slug: "spine", file: path.join(lib, "spine.cast") }, { slug: "check", file: null }] };
}

describe("a flow a session defines", () => {
  test("names itself from its digraph, and names the library flows it builds on", () => {
    expect(graphSlug(`// a note\ndigraph Flaky_Fix { }`)).toBe("flaky-fix");
    expect(graphSlug(`digraph "Two words" {}`)).toBe("two-words");
    expect(graphSlug(`{ a -> b }`)).toBeNull();
    expect(namedFlows(`digraph x { graph [extends="spine"] a [flow=check] b [flow="./local.cast"] }`)).toEqual(["spine", "check"]);
  });

  test("is kept in the checkout out of git, a draft of its session, its base pinned to the file the pool read", () => {
    const { top, pool } = checkout();
    const kept = writeSessionFlow(top, `digraph flaky { graph [extends="spine"] subgraph implement { a [prompt="Patch it."] } }`, "jx7abcd", pool);
    expect(kept.file).toBe(path.join(top, SESSION_FLOWS_DIR, "flaky", "flaky.cast"));
    expect(kept.source).toContain(`draft="jx7abcd"`);
    expect(fs.readFileSync(path.join(top, ".git", "info", "exclude"), "utf-8")).toContain(`/${SESSION_FLOWS_DIR}/`);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: top, encoding: "utf-8" }).stdout.trim()).toBe("");
    // The runner reads the file on its own and gets the backbone, station files and all, with the slot filled.
    const g = parseWorkflowFile(kept.file);
    expect(g.nodes.get("investigate")!.prompt).toBe("Find the cause.");
    expect(g.nodes.get("implement__a")!.prompt).toBe("Patch it.");
    expect(emptySlots(g)).toEqual([]);
    // Writing again keeps one exclude line.
    writeSessionFlow(top, `digraph other { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }`, null, pool);
    expect(fs.readFileSync(path.join(top, ".git", "info", "exclude"), "utf-8").split(`/${SESSION_FLOWS_DIR}/`).length).toBe(2);
  });

  test("refuses a name the library holds", () => {
    const { top, pool } = checkout();
    expect(() => writeSessionFlow(top, `digraph spine { graph [extends="spine"] }`, null, pool)).toThrow(/already has a flow named spine/);
  });
});
