import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A pane-focus gate must be a DEPENDENCY of the effect that installs the key
// listener, not only a check inside it. StackChecklist gated its n/p keys on
// paneActive but kept deps [move, keys]: the listener attached while the pane
// had focus stayed attached after focus moved away — which is the bug the gate
// was added to fix, still firing from a pane nobody is looking at.
const webRoot = join(import.meta.dir, "..", "..");
const SCAN = ["app", "components", "hooks"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path) && !path.includes(".test.")) out.push(path);
  }
  return out;
}

test("every effect gated on paneActive lists it as a dependency", () => {
  const offenders: string[] = [];
  for (const file of SCAN.flatMap((dir) => walk(join(webRoot, dir)))) {
    const src = readFileSync(file, "utf8");
    // Only files that gate an effect on the pane's focus.
    if (!src.includes("const paneActive = useTabActive()")) continue;
    if (!src.includes("!paneActive")) continue;
    if (!/\}, \[[^\]]*\bpaneActive\b[^\]]*\]/.test(src)) offenders.push(file.slice(webRoot.length + 1));
  }
  expect(offenders).toEqual([]);
});
