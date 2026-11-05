// The clash loop (Nov 5): Eval found the change clashing with main, the run rebuilt, and by its next Eval main had
// moved again. Each round spent one of Build's three visits, and ten runs ran out of them on clashes alone. A route
// marked `free_visit` sends the run back without spending a visit, up to the node's max_free_visits.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseWorkflowSource } from "./parser.js";
import { runWorkflow } from "./runner.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-wf-state-");

describe("workflow/runner (a round that spends no visit)", () => {
  let tmpDir: string;
  let origLog: typeof console.log;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-wf-free-")); origLog = console.log; console.log = () => {}; });
  afterEach(() => { console.log = origLog; fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // Eval clashes `clashes` times, then passes; Build takes 2 visits and `free` clash rounds.
  const line = (clashes: number, free: number, mark = true) => {
    const n = path.join(tmpDir, "evals");
    return parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      build [shape=parallelogram, max_visits=2, max_free_visits=${free}, script="true"]
      eval [shape=parallelogram, script="k=$(cat ${n} 2>/dev/null || echo 0); k=$((k+1)); echo $k > ${n}; if [ $k -le ${clashes} ]; then echo '{\\"clash\\": true}'; exit 1; fi"]
      exit [shape=Msquare]
      start -> build -> eval
      eval -> exit [condition="outcome = success"]
      eval -> build [condition="outcome = failure and eval.json.clash = true"${mark ? `, free_visit="build"` : ""}]
    }`);
  };

  test("clash rounds up to the node's free visits spend none of its visits", async () => {
    expect(await runWorkflow(line(3, 3), { cwd: tmpDir })).toBe("completed");
  });

  test("past its free visits a clash round counts again, and the cap stops the run", async () => {
    expect(await runWorkflow(line(3, 1), { cwd: tmpDir })).toBe("failed");
  });

  test("an edge without the mark spends a visit as before", async () => {
    expect(await runWorkflow(line(2, 3, false), { cwd: tmpDir })).toBe("failed");
  });
});
