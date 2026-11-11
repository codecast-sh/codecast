#!/usr/bin/env bun
// Opens a visible Chrome window on the local rig, signed in as Riley over the
// seeded review world, so a person can click through the redesign.
//   bun .impeccable/review/open.mjs [/path]
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { localDeployment } from "../../scripts/rig/stack.mjs";
import { chromeArgs, CHROME } from "../../scripts/rig/chrome.mjs";
import { connect, sleep } from "../../scripts/rig/cdp.mjs";
import { signIn } from "../../scripts/rig/auth.mjs";

const dep = localDeployment();
const world = JSON.parse(readFileSync(join(import.meta.dir, ".seed.json"), "utf8"));
const port = 9657, profile = "/tmp/cc-review-visible";
mkdirSync(profile, { recursive: true });
const args = chromeArgs({ port, profile, extra: ["--window-size=1440,900"] })
  .filter((a) => a !== "--headless=new" && a !== "--mute-audio");
const child = spawn(CHROME, args, { detached: true, stdio: "ignore" });
child.unref();
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
  await sleep(150);
}
const page = await connect(port, /about:blank|localhost/);
await signIn(page, dep, world.riley, process.argv[2] || "/inbox");
console.log("opened", dep.appUrl);
process.exit(0);
