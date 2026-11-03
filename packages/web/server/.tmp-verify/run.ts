import { Hono } from "hono";
import { botMetaMiddleware } from "../bot-meta";
const app = new Hono();
app.use("*", botMetaMiddleware);
app.get("*", (c) => c.text("SPA SHELL"));
const UA = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
for (const p of ["/conversation/jx71j8x24mxbap68mdqxtp80418hhj23", "/tasks/ct-4102", "/conversation/jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/blog", "/settings"]) {
  const r = await app.request(`https://codecast.sh${p}`, { headers: { "user-agent": UA } });
  const t = await r.text();
  console.log(p, "=>", t === "SPA SHELL" ? t : [...t.matchAll(/og:(title|description|url)" content="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`).join(" | "));
}
