// A repo flow's default-branch copy (repoFlowAtDefault.ts) is written under this machine's flow cache, outside any
// checkout of the repo. Its directory carries a marker naming the repo it was read from, so a push of the copy records
// that directory as where the graph lives (lineGraphEdit.ts graphOrigin) and the daemon that runs it knows the copy as
// its run's own repo's flow (daemonGraph.ts). Without it the copy reads as a file of whatever git repo holds the cache
// (a home directory kept in git): a push recorded that repo, and the daemon took the run's flow for another repo's and
// ran the behind checkout's instead, the shipped template with no Local CI (ct-102787, ct-102790).
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultFlowsCache } from "./teamFlowIndex.js";

const MARKER = ".codecast-flow-copy";

/** Mark `dir` as the default-branch copy of the repo whose git common dir is `repo`. */
export function markFlowCopy(dir: string, repo: string, sha: string): void {
  const text = `${JSON.stringify({ repo, sha })}\n`;
  const file = path.join(dir, MARKER);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === text) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
}

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Whether `dir` sits inside this machine's flow cache: a marker anywhere else (a stray file in a checkout) is no copy. */
function inCache(dir: string): boolean {
  const rel = path.relative(real(defaultFlowsCache()), real(dir));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The default-branch copy directory holding `abs`, or null when `abs` is in none. */
export function flowCopyRoot(abs: string): string | null {
  for (let dir = path.dirname(path.resolve(abs)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, MARKER))) return inCache(dir) ? dir : null;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The repo (its git common dir) the copy at `root` was read from, or null when `root` is no copy. */
export function flowCopyRepo(root: string): string | null {
  if (!inCache(root)) return null;
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(root, MARKER), "utf-8"))?.repo;
    return typeof repo === "string" && repo ? repo : null;
  } catch {
    return null;
  }
}
