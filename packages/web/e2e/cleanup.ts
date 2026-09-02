import { ConvexHttpClient } from "convex/browser";
import { api } from "@codecast/convex/convex/_generated/api";
const tokens = JSON.parse(await Bun.file("/tmp/e2e-tokens.json").text());
const c = new ConvexHttpClient("https://convex.codecast.sh");
c.setAuth((tokens.tokens ?? tokens).token);
const list = async () => ((await c.query(api.conversations.listInboxSessions, { show_all: true, include_liveness: false, fast_fields_in_overlay: true })) as any).sessions.filter((r: any) => r.project_path === "/tmp/codecast-e2e");
for (const r of await list()) { const out = await c.mutation(api.conversations.deleteByProjectHash, { project_hash: "e2e", conv_id: r._id } as any); console.log("delete", r._id.slice(0, 6), JSON.stringify(out).slice(0, 100)); }
console.log("remaining e2e rows:", (await list()).length);
