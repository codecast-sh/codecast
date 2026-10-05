import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
const c = new ConvexHttpClient("https://convex.codecast.sh");
c.setAuth(readFileSync("/tmp/cloudfix2/jwt", "utf8").trim());
const [fn, argsJson] = process.argv.slice(2);
const r = await (c as any).mutation(fn, JSON.parse(argsJson));
console.log(JSON.stringify(r));
