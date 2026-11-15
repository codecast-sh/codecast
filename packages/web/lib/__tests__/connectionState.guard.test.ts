import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

// useConvexConnectionState() re-emits on every in-flight request, so each
// consumer re-renders twice per mutation: in the doc editor that was every
// topbar chip and DesktopProvider on every keystroke. Read connectivity
// through hooks/useWsConnected, which wakes only when the socket flips.
test("nothing subscribes to the whole Convex connection state", () => {
  const web = join(import.meta.dir, "..", "..");
  const offenders: string[] = [];
  for (const dir of ["app", "components", "hooks", "lib", "src", "store"]) {
    for (const file of new Glob(`${dir}/**/*.{ts,tsx}`).scanSync(web)) {
      if (file.includes("__tests__") || file.includes(".test.")) continue;
      if (/\buseConvexConnectionState\s*\(/.test(readFileSync(join(web, file), "utf8").replace(/^\s*(\/\/|\*).*$/gm, ""))) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
