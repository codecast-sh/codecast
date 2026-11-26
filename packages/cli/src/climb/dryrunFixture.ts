// The climb's fake product, shared by the climb's tests: a runner that emits
// the env result contract, the envs a scratch repo declares, a card, and the
// env version the base's grader hashes to. Not a test file: tests import it.
// The fake runner: 40 dev and 30 held cases scored 0.5 plus the tree's
// effect on that split plus a deterministic draw that moves with each run
// (the A/A spread). fake/noisy draws ten times wider. fake/floor fails a case
// when the tree pushes on people (pressure.txt). The version is a hash of
// the grader, so a tree that edits it reports another env.
export const RUNNER = `
import fs from "node:fs";
import { createHash } from "node:crypto";
const [env, split, out] = process.argv.slice(2);
const counter = process.env.FAKE_COUNTER;
const shifts = (process.env.FAKE_SHIFT ?? "").split(",").map(Number);
const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0") + 1;
fs.writeFileSync(counter, String(n));
const eff = {};
if (fs.existsSync("effect.txt")) for (const l of fs.readFileSync("effect.txt", "utf8").split("\\n")) { const [k, v] = l.split("="); if (k) eff[k.trim()] = Number(v); }
const version = createHash("sha256").update(fs.readFileSync("evals/grader.txt")).digest("hex").slice(0, 12);
const cases = [];
// FAKE_VOID: the candidate leaves a case the base scored unscored. FAKE_BASE_ABSENT: the base has cases it never
// scores (a team's empty pitch lists), and the candidate scores them.
const cand = process.env.CODECAST_ENV_CANDIDATE !== "base";
const absent = process.env.FAKE_BASE_ABSENT && !cand ? 1 : 0;
if (env === "fake/floor") {
  for (let i = 1; i <= (cand && process.env.FAKE_VOID ? 4 : 5) - absent; i++) cases.push({ id: "f" + i, score: i === 3 && fs.existsSync("pressure.txt") ? 0 : 1 });
} else if (env === "fake/fit") {
  for (let i = 1; i <= 20 - 5 * absent; i++) cases.push({ id: "p" + i, score: Math.min(1, Math.max(0, 0.8 + (eff.fit ?? 0))) });
} else {
  const wide = env === "fake/noisy" ? 0.1 : 0.005;
  const count = split === "held" ? 30 : 40;
  for (let i = 1; i <= count; i++) {
    const draw = (((i * 7 + (process.env.FAKE_SAME ? 0 : n) * 13) % 9) - 4) * wide;
    const few = i % 5 === 0 ? (eff[split + "_few"] ?? 0) : 0;
    cases.push({ id: (split === "held" ? "h" : "d") + i, score: Math.min(1, Math.max(0, 0.5 + (eff[split] ?? 0) + few + draw + (shifts[n - 1] || 0))) });
  }
}
const mean = cases.reduce((a, c) => a + c.score, 0) / cases.length;
const now = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify({ env, env_version: version, level: env === "fake/floor" ? "L0" : env === "fake/noisy" ? "L1" : "L2",
  candidate: { label: process.env.CODECAST_ENV_CANDIDATE }, split, cases, summary: { n: cases.length, mean, ...(process.env.FAKE_VOID && cand && env === "fake/floor" ? { unscored: 1 } : absent ? { unscored: env === "fake/fit" ? 5 : 1 } : {}) }, cost_usd: env === "fake/floor" ? 0 : 0.25, started_at: now, finished_at: now }));
`;

export const ENVS = `
[[env]]
key = "fake/floor"
title = "Irreversible floor"
level = "L0"
command = "bun {root}/evals/run.mjs fake/floor {split} {out}"
splits = ["dev"]
protects = ["evals/**"]

[[env]]
key = "fake/noisy"
title = "A noisy sim"
level = "L1"
command = "bun {root}/evals/run.mjs fake/noisy {split} {out}"
splits = ["dev", "held"]
protects = ["evals/**"]

[[env]]
key = "fake/replay"
title = "Labelled replay"
level = "L2"
command = "bun {root}/evals/run.mjs fake/replay {split} {out}"
splits = ["dev", "held"]
cost_usd = 0.25
protects = ["evals/**"]

[[env]]
key = "fake/fit"
title = "Share of picks the fit read passes"
level = "L2"
command = "bun {root}/evals/run.mjs fake/fit {split} {out}"
splits = ["dev"]
protects = ["evals/**"]
role = "check"
tolerance = 0.02
`;

export const CARD = {
  goal: "in-1", metric: "yes_rate", production_lift: 0.04, target: "matched to opted in, furthest behind its trajectory",
  levels: [{ env: "fake/noisy", plausible_effect: 0.05 }, { env: "fake/replay", plausible_effect: 0.04 }],
  budget: { usd: 1000, runs: 500 }, candidates: 6, hypotheses: ["lead with the need", "shorter pitch"],
};

// The fake runner's version: a hash of the base's grader.
export const VERSION = new Bun.CryptoHasher("sha256").update("grade strictly\n").digest("hex").slice(0, 12);
