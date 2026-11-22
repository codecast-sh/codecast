import { liveFlowView } from "./liveFlows";
export async function probe(ctx: any, flowId: string) {
  const tally: Record<string, [number, number]> = {};
  let total = 0;
  const caller = () => {
    const lines = (new Error().stack ?? "").split("\n").slice(3).map((l) => l.trim().replace(/^at (async )?/, "").split(" ")[0]).filter((n) => n && !n.startsWith("Object.") && !n.includes("Proxy") && !n.startsWith("<anon") && n !== "new" && !n.startsWith("wrap") && !n.startsWith("Promise") && !n.startsWith("file:") && !n.startsWith("testQuery"));
    return lines.slice(0, 3).join("<");
  };
  const add = (label: string, v: any) => {
    const n = v == null ? 0 : JSON.stringify(v).length;
    const t = (tally[label] ??= [0, 0]);
    t[0] += Array.isArray(v) ? v.length : 1; t[1] += n; total += n;
    if (total > 70_000_000) throw new Error("PROBE_STOP");
  };
  const wrapQ = (q: any, label: string): any => new Proxy(q, {
    get(target, prop) {
      const f = target[prop];
      if (typeof f !== "function") return f;
      return (...a: any[]) => {
        const r = f.apply(target, a);
        const lab = prop === "withIndex" ? `${label}.${a[0]}` : label;
        if (["collect", "take", "first", "unique"].includes(prop as string)) { const c = caller(); return r.then((v: any) => { add(`${lab}.${String(prop)} @${c}`, v); return v; }); }
        if (r && typeof r === "object" && !(r instanceof Promise)) return wrapQ(r, lab);
        return r;
      };
    },
  });
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      if (prop === "query") return (t: string) => wrapQ(target.query(t), t);
      if (prop === "get") return async (id: any) => { const c = caller(); const v = await target.get(id); add(`get @${c}`, v); return v; };
      const f = target[prop]; return typeof f === "function" ? f.bind(target) : f;
    },
  });
  let err: string | null = null;
  try { await liveFlowView({ ...ctx, db }, await ctx.db.get(flowId)); } catch (e: any) { err = e.message; }
  return { err, total, top: Object.entries(tally).sort((a, b) => b[1][1] - a[1][1]).slice(0, 25) };
}
