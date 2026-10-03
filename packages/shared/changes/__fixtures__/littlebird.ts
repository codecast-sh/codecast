// A Littlebird-shaped day for scale tests: deterministic, so the cluster
// timing test and the Convex read-size tests see the same rows.
import { makeRng } from "../../random";
import type { ChangeCommit } from "../types";
import { commit, MIN, T0 } from "./commit";

/** A Littlebird-shaped day: 760 commits, 45 branches, sparse sessions, a few batch commits and twins. */
export function littlebirdDay(): ChangeCommit[] {
  const rnd = makeRng(7);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const dirs = ["backend/api", "backend/worker", "backend/db", "backend/auth", "apps/web", "apps/mobile", "apps/admin", "packages/ui", "packages/sdk", "infra"];
  const types = ["feat", "fix", "chore", "refactor", "test", "docs", "perf"];
  const branches = Array.from({ length: 45 }, (_, i) => `dev${i % 9}/topic-${i}`);
  const out: ChangeCommit[] = [];
  for (let i = 0; i < 760; i++) {
    const main = i % 10 === 0;
    const batch = rnd() < 0.05;
    const dir = pick(dirs);
    const paths: Record<string, number> = {};
    const n = 1 + Math.floor(rnd() * 30);
    for (let f = 0; f < n; f++) paths[`${batch ? pick(dirs) : dir}/src/f${Math.floor(rnd() * 400)}.ts`] = Math.floor(rnd() * 120);
    const area = dir.split("/").pop();
    out.push(commit({
      sha: `lb${i.toString(16).padStart(6, "0")}`,
      subject: i % 97 === 0 && main ? `chore(release): bump version to 2.${i}.0` : `${pick(types)}(${area}): change ${i}`,
      author_email: `dev${i % 23}@littlebird.test`,
      author_name: `Dev ${i % 23}`,
      timestamp: T0 - 12 * 60 * MIN + Math.floor(rnd() * 24 * 60) * MIN,
      branch: main ? "main" : pick(branches),
      conversation_id: rnd() < 0.015 ? `jx7lb${i % 5}` : null,
      paths,
    }));
  }
  // Rebase twins: some main commits also arrive from the branch they came from.
  for (let i = 0; i < 20; i++) out.push({ ...out[i * 10], sha: `tw${i}`, branch: pick(branches) });
  return out;
}
