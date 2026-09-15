import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
const jwt = JSON.parse(await Bun.file("/tmp/minted.json").text().then((t) => t.match(/\{.*\}/s)![0])).tokens.token;
const client = new ConvexHttpClient("https://convex.codecast.sh");
client.setAuth(jwt);
const mode = Bun.argv[2];
if (mode === "url") {
  const res: any = await client.action(makeFunctionReference<"action">("slack:getInstallUrl"), {
    scope_type: "team", team_id: "k97cc9y1a48swe3kfnwcs44a857wmxj2",
    return_to: "/chat/hx7wxpz5cyqg7c8444kwfpa2qs8ecp7e", origin: "https://local.codecast.sh",
  });
  if (!res?.ok) { console.log("ERR " + res?.error); process.exit(1); }
  console.log(res.url);
} else if (mode === "complete") {
  const res: any = await client.action(makeFunctionReference<"action">("slack:completeSlackInstall"), { code: Bun.argv[3], state: Bun.argv[4] });
  console.log(JSON.stringify(res));
}
