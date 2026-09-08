import { ConvexHttpClient } from "convex/browser";
import * as fs from "node:fs";
import * as path from "node:path";
import { GitActivityTailer } from "./gitActivity.js";
import { repositoryKeyFor } from "./repoMirror.js";
import { decryptToken, isEncryptedToken } from "./tokenEncryption.js";
import { defaultConfigDir } from "./config/configDir.js";

const [root, seconds] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(defaultConfigDir(), "config.json"), "utf-8"));
const token = isEncryptedToken(config.auth_token) ? decryptToken(config.auth_token) : config.auth_token;
const client = new ConvexHttpClient(config.convex_url);
const tailer = new GitActivityTailer(root);
console.log("init", await tailer.init());
const until = Date.now() + Number(seconds ?? 90) * 1000;
while (Date.now() < until) {
  const events = await tailer.poll();
  if (events.length) {
    const result = await client.mutation("gitActivity:recordLocal" as any, { api_token: token, root, repository: repositoryKeyFor(root, undefined), branch: undefined, events });
    console.log(new Date().toISOString(), events.map((e) => e.kind).join(","), JSON.stringify(result));
  }
  await new Promise((r) => setTimeout(r, 1000));
}
