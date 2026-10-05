// Regrade the playbook gate of existing role-wake reps from their saved
// brief.md with today's parser, then weigh each fixture with the harness's
// own separation test. Reads only; writes nothing.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { separate } from "./src/stats";
import { playbookGate, budgetGate } from "./src/surfaces/roleWake/actions";
const root = join(process.env.HOME!, ".local/share/codecast/evals/runs");
const FIX: Record<string, string> = { "3a76279a": "playbook-steady", a9320071: "playbook-start", a9ef8adb: "playbook-quiet", adde04f4: "playbook-full" };
const label = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/role-wake", `${name}.json`), "utf8")).label;
type Rep = { score: number; failed: string[] };
function reps(batch: string, fz: string): Rep[] {
  return readdirSync(root).filter((d) => d.startsWith(`role-wake-${fz}`)).flatMap((d) => {
    const dir = join(root, d);
    if (!existsSync(join(dir, "run.json")) || !existsSync(join(dir, "score.json")) || JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).batch !== batch) return [];
    const sc = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
    const brief = existsSync(join(dir, "brief.md")) ? readFileSync(join(dir, "brief.md"), "utf8") : null;
    const kept = (sc.gates as any[]).filter((g) => g.id !== "playbook-kept" && g.id !== "brief-budget");
    const mine = brief === null ? [] : [budgetGate(brief), playbookGate(brief, label(FIX[fz]).playbook ?? {})];
    const failed = [...kept, ...mine].filter((g) => !g.pass).map((g) => `${g.id}: ${g.evidence.summary}`);
    const judge = sc.checks?.[0]?.score ?? 0;
    return [{ score: failed.length ? 0 : judge, failed }];
  });
}
const [base, ...variants] = process.argv.slice(2);
const pass = (xs: Rep[]) => `${xs.filter((x) => x.score >= 0.7).length}/${xs.length}`;
for (const b of [base, ...variants]) {
  console.log(`\n== ${b}`);
  for (const [fz, name] of Object.entries(FIX)) {
    const now = reps(b, fz), then = reps(base, fz);
    const why = new Map<string, number>();
    for (const r of now) for (const f of r.failed) why.set(f.slice(0, 110), (why.get(f.slice(0, 110)) ?? 0) + 1);
    const sep = b === base ? "" : `  vs ${base} ${pass(then)}: ${JSON.stringify(separate(now.map((r) => r.score), then.map((r) => r.score)))}`;
    console.log(`${name.padEnd(16)} pass ${pass(now)}${sep}`);
    for (const [k, n] of why) console.log(`     ${n}x ${k}`);
  }
}
