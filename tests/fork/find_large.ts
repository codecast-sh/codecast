import { httpAction, getConfig } from "./api";
const cfg = getConfig();
const paths = ["/Users/ashot/src/codecast", "/Users/ashot/src/union-mobile/outreach", "/Users/ashot/src/union-mobile"];
const mine = cfg.user_id;
const seen = new Set<string>();
const all: any[] = [];
for (const p of paths) {
  const res: any = await httpAction("/cli/feed", { limit: 300, project_path: p });
  for (const c of (res.conversations||[])) { if(!seen.has(c._id)){seen.add(c._id); all.push(c);} }
}
const big = all.filter(c => (c.message_count ?? 0) >= 80 && !c.forked_from);
big.sort((a,b)=> (b.message_count??0)-(a.message_count??0));
const byOwner: Record<string, number> = {};
for (const c of all) { const k=c.user_id===mine?"MINE":"OTHER"; byOwner[k]=(byOwner[k]||0)+1; }
console.log(`feed total=${all.length}, large(>=80,nonfork)=${big.length}, ownership=`, byOwner);
console.log("\n--- top large ---");
for (const c of big.slice(0,30))
  console.log(`${(c.user_id===mine?"MINE ":"OTHER")} ${String(c.message_count).padStart(4)} | ${(c.short_id||'').padEnd(8)} | ${(c.title||"").slice(0,40).padEnd(40)} | ${c.project_path||""}`);
