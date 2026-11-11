// Replay the stale-copy detector on real commits: a commit's parent stands in for HEAD and its tree for the frozen
// tree. A range <first>..<last> replays a whole ship batch as one freeze: first's parent against last's tree.
//   bun scripts/stale-incident.ts <repo> <commit | first..last>...
import { frozenChanges } from "../src/land/commitGroups.js";
import { treeDiff } from "../src/land/level.js";
import { findStaleCopies } from "../src/land/staleCopy.js";
import { git } from "../src/wipSnapshot.js";

const [repo, ...commits] = process.argv.slice(2);
for (const c of commits) {
  const [first, last] = c.includes("..") ? c.split("..") : [c, c];
  const sha = await git(repo, ["rev-parse", last]);
  const base = await git(repo, ["rev-parse", `${first}^`]);
  const tree = await git(repo, ["rev-parse", `${sha}^{tree}`]);
  const changes = frozenChanges(await treeDiff(repo, base, tree));
  const started = Date.now();
  const stale = await findStaleCopies(repo, { base, tree, upstream: base, changes, claimed: () => true });
  console.log(`## ${c}: ${stale.size} of ${changes.length} changed file(s) held, ${Date.now() - started}ms`);
  for (const ch of changes) {
    const s = stale.get(ch.path);
    console.log(`${s ? "HELD " : "ships"} ${ch.path}${s ? ` | ${s.reason} | ${s.reverts.slice(0, 4).join("; ")}` : ""}`);
  }
}
