// Shared setup for convex-test suites. The file name carries two dots so the
// Convex bundler skips it (it uses Bun's file glob and resolver, which the
// Convex runtime does not have).
import { dirname } from "node:path";

const convexDir = import.meta.dir;

/**
 * Every function module of the deployment, as the convex-test `modules` map,
 * each loaded only when a test reaches it. The set is the one the bundler
 * deploys: no generated files, and no file whose name has more than one dot
 * (tests, testkits). A suite whose writes schedule side effects (titles, live
 * activity, wakes) finds every function they name.
 */
export const allModules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./_generated/server"),
  ...Object.fromEntries(
    [...new Bun.Glob("**/*.ts").scanSync(convexDir)]
      .filter((file) => !file.startsWith("_generated/") && (file.split("/").pop()!.match(/\./g) ?? []).length === 1)
      .map((file) => [`./${file}`, () => import(`${convexDir}/${file}`)]),
  ),
};

/**
 * pi-ai as @platform/agent resolves it, so a faux provider a test registers
 * lands in the same registry the harness streams through. A plain import from
 * this package could resolve a different copy.
 */
export async function loadPiAi(): Promise<any> {
  const agentEntry = Bun.resolveSync("@platform/agent", convexDir);
  return import(Bun.resolveSync("@mariozechner/pi-ai", dirname(agentEntry)));
}
