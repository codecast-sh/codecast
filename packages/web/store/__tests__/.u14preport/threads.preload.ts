import { afterAll } from "bun:test";
afterAll(() => {
  const out = Bun.spawnSync(["ps", "-M", "-p", String(process.pid)]).stdout.toString();
  const tot = out.trim().split("\n").slice(1).map((l) => { const ts = [...l.matchAll(/(\d+):(\d+\.\d+)/g)].map((m) => Number(m[1]) * 60 + Number(m[2])); return ts.slice(0, 2).reduce((a, b) => a + b, 0); }).sort((a, b) => b - a);
  console.log(`[threads] n=${tot.length} top cpu s: ${tot.slice(0, 8).map((x) => x.toFixed(2)).join(" ")} sum=${tot.reduce((a, b) => a + b, 0).toFixed(2)}`);
});
