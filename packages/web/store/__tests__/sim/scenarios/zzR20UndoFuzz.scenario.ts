// SCRATCH (validation round 20, ct-56508): randomized undo/redo across windows. Delete after use.
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { scenario, type ScenarioWorld } from "../dsl";

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fuzz(w: ScenarioWorld, steps: number, withOther: boolean) {
  w.user("ada");
  const sessions = ["s1", "s2", "s3"].map((n) => w.session("ada", n, { agentStatus: "idle" }));
  const a = await w.device("ada", { followers: 1 });
  const other = withOther ? await w.device("ada") : null;
  const wins = [a.host, a.followers[0]!, ...(other ? [other.host] : [])];
  for (const win of wins) await w.expect(win).shows(sessions[0]!);
  const scriptSeed = Number(process.env.FUZZ_SCRIPT ?? 0);
  const rng = mulberry(w.seed * 7919 + 13 + scriptSeed * 104729);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
  const log: string[] = [];
  for (let i = 0; i < steps; i++) {
    const win = pick(wins);
    const s = pick(sessions);
    const r = rng();
    const h = w.human(win);
    let what: string;
    if (r < 0.15) { h.stash(s); what = `stash ${s}`; }
    else if (r < 0.27) { h.kill(s); what = `kill ${s}`; }
    else if (r < 0.4) { h.pin(s); what = `pin ${s}`; }
    else if (r < 0.48) { h.restore(s); what = `restore ${s}`; }
    else if (process.env.FUZZ_NOUNDO) { what = "noop"; }
    else if (r < 0.8) { h.undo(); what = "undo"; }
    else { h.redo(); what = "redo"; }
    log.push(`${win.name}: ${what}`);
    if (rng() < 0.4) await w.settle();
  }
  (globalThis as any).__fuzzLog = log;
  console.log(`[fuzz ${w.seed}/${scriptSeed}] ${log.join(" | ")}`);
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
}

const K = { "INV-followers": "ct-56817", "INV-pending-locks": "ct-56817" };
scenario({ name: "zzR20UndoFuzzOneDevice", seeds: 14, known: K }, (w) => fuzz(w, 10, false));
scenario({ name: "zzR20UndoFuzzTwoDevices", seeds: 14, known: K }, (w) => fuzz(w, 10, true));

scenario({ name: "zzR20RestoreShownUndoFollower", seeds: 10, known: { "INV-followers": "ct-56817" } }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s3", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).restore(s);
  await w.settle();
  w.human(f).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
});
scenario({ name: "zzR20RestoreShownUndoHost", seeds: 10, known: { "INV-followers": "ct-56817" } }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s3", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  w.human(a.host).restore(s);
  await w.settle();
  w.human(a.host).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
});
