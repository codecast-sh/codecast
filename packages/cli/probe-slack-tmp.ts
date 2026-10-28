import { readAuthConfig, defaultConfigDir } from "./src/config/readAuthConfig.js";
import { ConvexHttpClient } from "convex/browser";
import { writeFileSync } from "fs";
const out = "/Users/samvit/dev/codecast/packages/cli/probe-slack-out.json";
const cfg = readAuthConfig(defaultConfigDir())!;
const client = new ConvexHttpClient(cfg.convex_url || "https://convex.codecast.sh");
try {
  const r = await client.action("slack:getInstallUrl" as any, { api_token: cfg.auth_token, scope_type: "self", return_to: "/chat", origin: "https://codecast.sh" });
  writeFileSync(out, JSON.stringify(r));
} catch (e) {
  writeFileSync(out, JSON.stringify({ err: String(e) }));
}
process.exit(0);
