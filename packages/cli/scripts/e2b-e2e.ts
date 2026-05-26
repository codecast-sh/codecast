/**
 * D3: live E2B end-to-end through the E2bBackend (not raw SDK).
 *
 * Budget guard: E2B bills per-second (~$0.000014/s for the base sandbox).
 * This whole test runs in well under a minute = fractions of a cent. We set
 * a hard wall-clock cap and kill everything if exceeded.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { E2bBackend } from "../src/workspace/backends/e2b.js";

const BUDGET_WALL_MS = 5 * 60 * 1000; // 5 min hard cap
const started = Date.now();
function budgetCheck(label: string) {
  const elapsed = Date.now() - started;
  if (elapsed > BUDGET_WALL_MS) {
    throw new Error(`BUDGET EXCEEDED at ${label}: ${elapsed}ms > ${BUDGET_WALL_MS}ms`);
  }
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2b-e2e-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "e2b-e2e fixture\n");
  fs.writeFileSync(path.join(dir, "marker.txt"), "tarball-push-worked\n");
  // Manifest with a trivial install command to prove setup runs in-sandbox.
  fs.mkdirSync(path.join(dir, ".codecast"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".codecast/workspace.toml"),
    `backend = "e2b"\n\n[setup]\ninstall = ["echo INSTALL_RAN > install-proof.txt"]\n`,
  );
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

async function main() {
  const repoRoot = makeRepo();
  const name = "feat-e2b-e2e";
  console.log(`repo: ${repoRoot}`);

  try {
    console.log("\n=== acquire (tarball push + in-sandbox setup) ===");
    const t0 = Date.now();
    const ws = await E2bBackend.acquire(repoRoot, name);
    console.log(`acquired in ${Date.now() - t0}ms, path=${ws.path}, state=${ws.state}`);
    budgetCheck("post-acquire");

    console.log("\n=== exec: prove we're in a Linux sandbox + repo contents present ===");
    const u = await E2bBackend.exec(repoRoot, name, "uname -s && cat marker.txt && cat install-proof.txt");
    console.log(`exit=${u.exitCode} durationMs=${u.durationMs}`);
    console.log("stdout:", JSON.stringify(u.stdout));
    if (u.exitCode !== 0) throw new Error("exec failed");
    if (!u.stdout.includes("Linux")) throw new Error("expected Linux uname");
    if (!u.stdout.includes("tarball-push-worked")) throw new Error("repo contents missing in sandbox");
    if (!u.stdout.includes("INSTALL_RAN")) throw new Error("setup install command did not run in sandbox");
    budgetCheck("post-exec");

    console.log("\n=== exec: non-zero exit returns code without throwing ===");
    const fail = await E2bBackend.exec(repoRoot, name, "exit 23");
    console.log(`exit=${fail.exitCode}`);
    if (fail.exitCode !== 23) throw new Error("expected exit 23");

    console.log("\n=== writeFile + readFile roundtrip ===");
    await E2bBackend.writeFile(repoRoot, name, "sub/dir/hello.txt", "hello-from-host\n");
    const back = await E2bBackend.readFile(repoRoot, name, "sub/dir/hello.txt");
    console.log("read back:", JSON.stringify(back.toString("utf-8")));
    if (back.toString("utf-8") !== "hello-from-host\n") throw new Error("file roundtrip mismatch");
    budgetCheck("post-fileio");

    console.log("\n=== validate ===");
    const v = await E2bBackend.validate(repoRoot, name);
    console.log("validate ok:", v.ok, "checks:", JSON.stringify(v.checks));
    if (!v.ok) throw new Error("validate failed");

    console.log("\n=== list ===");
    const list = await E2bBackend.list(repoRoot);
    console.log("workspaces:", list.map((w) => w.name));
    if (!list.find((w) => w.name === name)) throw new Error("list missing workspace");

    console.log("\n=== release (kills sandbox) ===");
    await E2bBackend.release(repoRoot, name);
    console.log("released");

    const elapsed = Date.now() - started;
    const estCost = (elapsed / 1000) * 0.000014; // rough base-sandbox rate
    console.log(`\n✓ D3 PASS — E2B live e2e. wall=${elapsed}ms est-cost≈$${estCost.toFixed(5)}`);
  } catch (e) {
    // Best-effort cleanup so we never leak a billing sandbox.
    try { await E2bBackend.release(repoRoot, name); } catch {}
    const err = e as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    console.error(`✗ D3 FAIL: ${err.message}`);
    if (err.stderr) console.error("stderr:", err.stderr.toString());
    if (err.stdout) console.error("stdout:", err.stdout.toString());
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

main();
