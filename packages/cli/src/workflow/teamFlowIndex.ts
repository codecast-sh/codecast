// Where the team's published flows sit on this machine (docs/architecture/flows.md FL2, FL3): each one the CLI
// read from the pool is written under ~/.codecast/flows/<row id>/ for running (flowPool.ts materializePushedFlow),
// and this index names it by slug, so a flow that uses a team flow as a segment resolves it here, on this machine,
// for a local run and a daemon run alike. Read by the parser after the repo's and the shipped flows.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** ~/.codecast/flows, or CODECAST_FLOWS_CACHE (tests point it at a temp dir). */
export const defaultFlowsCache = () => process.env.CODECAST_FLOWS_CACHE || path.join(os.homedir(), ".codecast", "flows");
const indexFile = (cacheRoot: string) => path.join(cacheRoot, "index.json");

/** The team flows' files by slug, as last read from the pool. */
export function readTeamFlowIndex(cacheRoot = defaultFlowsCache()): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(cacheRoot), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Record where each team flow was written; a slug read again points at its newest file. */
export function writeTeamFlowIndex(files: ReadonlyMap<string, string>, cacheRoot = defaultFlowsCache()): void {
  if (!files.size) return;
  const next = { ...readTeamFlowIndex(cacheRoot), ...Object.fromEntries(files) };
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(indexFile(cacheRoot), JSON.stringify(next, null, 2) + "\n");
}

/** A team flow's file by slug, when this machine has one. */
export function teamFlowFile(slug: string, cacheRoot = defaultFlowsCache()): string | null {
  const file = readTeamFlowIndex(cacheRoot)[slug];
  return file && fs.existsSync(file) ? file : null;
}
