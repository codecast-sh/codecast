#!/usr/bin/env bun
// Design-review screenshots over the local rig (scripts/rig): seeds a small
// realistic world once, signs in headless as Riley, and photographs the main
// signed-in routes in light and dark.
//   bun .impeccable/review/shoot.mjs <outdir> [--seed] [--only inbox,tasks] [--theme light|dark|both]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { localDeployment, adminClient } from "../../scripts/rig/stack.mjs";
import { seedWorld } from "../../scripts/rig/seed.mjs";
import { launchSignedIn, killChrome } from "../../scripts/rig/chrome.mjs";
import { sleep } from "../../scripts/rig/cdp.mjs";

const args = process.argv.slice(2);
const OUT = args[0] || "/tmp/cc-shots";
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt("only", "");
const THEMES = (opt("theme", "both") === "both" ? ["light", "dark"] : [opt("theme")]);
const W = Number(opt("w", 1440)), H = Number(opt("h", 900));
mkdirSync(OUT, { recursive: true });

const dep = localDeployment();
const STATE = join(import.meta.dir, ".seed.json");
let world;
if (args.includes("--seed") || !existsSync(STATE)) {
  world = await seedWorld(dep);
  const riley = adminClient(dep, world.riley);
  const now = Date.now();
  const sessions = [
    ["Sender auth parsing fix", "littlebird", "Fix the sender-authentication parsing weakness on both backends and open a PR.", "The SPF result parser trusted the first header it found. I now read the Authentication-Results header the receiving server added and ignore any copies above it. Tests cover both backends."],
    ["Adversarial review audit", "littlebird", "Is the Fable/Astra adversarial review producing useful output? Is the juice worth the squeeze?", "I sampled 60 review pairs from the last 30 days. 41% of findings were acted on; most of the useful ones came from the second reviewer."],
    ["Routing gap rollout fix", "littlebird", "Fix the routing gap in the TypeScript backend rollout config and open a PR.", "The ingress rule sent /webhooks/* to the old service. I added the route and a test that fails when a webhook path is unrouted."],
    ["Codecast design pass", "codecast", "Install the impeccable design skills and do a design pass on Codecast: simplify it and de-slop the design.", "Impeccable is installed. I set up a clean worktree off the latest main and took screenshots of the inbox, a conversation and Tasks."],
    ["1:1 chat message bug", "codecast", "Why are these messages still showing up in 1:1 chats?", "The daily deal-desk trigger posts into the DM because its target resolves to the person, not a channel. The fix depends on a product choice I've filed."],
    ["Mobile app bug fixes", "littlebird", "Work through the list of mobile app problems, starting with voice input.", "Voice input drops the last word because the recognizer stops on silence before flushing. Fixed and verified on a simulator."],
    ["Instinct texting style analysis", "littlebird", "Reverse-engineer the texting style of the Instinct assistant.", "Messages average 11 words, never use exclamation marks, and split long answers across two or three bubbles sent a beat apart."],
  ];
  const ids = [];
  for (const [i, [title, proj, user, assistant]] of sessions.entries()) {
    const id = String(await riley.mutation("conversations:createConversation", {
      user_id: world.riley, team_id: world.teamId, agent_type: "claude_code", session_id: crypto.randomUUID(),
      project_hash: `review-${proj}`, project_path: `/Users/riley/code/${proj}`, title, started_at: now - (i + 1) * 9 * 60_000,
    }));
    await riley.mutation("messages:addMessage", { conversation_id: id, role: "user", content: user, message_uuid: crypto.randomUUID() });
    await riley.mutation("messages:addMessage", { conversation_id: id, role: "assistant", content: assistant, message_uuid: crypto.randomUUID() });
    ids.push(id);
  }
  world.conversations = ids;
  writeFileSync(STATE, JSON.stringify(world));
} else world = JSON.parse(readFileSync(STATE, "utf8"));

const conv = world.conversations?.[3];
const ROUTES = [
  ["inbox", "/inbox"],
  ["conversation", conv ? `/conversation/${conv}` : "/inbox"],
  ["tasks", "/tasks"],
  ["docs", "/docs"],
  ["chat", "/chat"],
  ["decisions", "/decisions"],
  ["settings", "/settings"],
];
const SHOWN = ROUTES.filter(([n]) => !ONLY || ONLY.split(",").includes(n));
for (const extra of (opt("paths", "") || "").split(",").filter(Boolean)) SHOWN.push([extra.replace(/^\//, "").replace(/\//g, "_") || "root", extra]);

const port = 9655, profile = "/tmp/cc-review-profile";
const { child, page } = await launchSignedIn({ port, profile, dep, userId: world.riley, path: "/inbox" });
await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
const me = adminClient(dep, world.riley);
for (const theme of THEMES) {
  await me.mutation("dispatch:dispatch", { action: "updateClientUI", args: [{ theme }], result: { theme, "theme:ts": Date.now() } });
  for (const [name, path] of SHOWN) {
    // The inbox board shows only with no session open: close the open tab and
    // the current conversation first, as closing every tab does (seed.mjs).
    if (name === "inbox") {
      await me.mutation("dispatch:dispatch", {
        action: "closeTab", args: [], patches: { client_state: { [world.riley]: { tabs: null, activeTabId: null, current_conversation_id: null } } },
      });
      await page.send("Page.navigate", { url: "about:blank" });
      await sleep(500);
    }
    await page.send("Page.navigate", { url: `${dep.appUrl}${path}` });
    await sleep(Number(opt("wait", 4500)));
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}-${theme}${W < 600 ? "-mobile" : ""}.png`), Buffer.from(shot.data, "base64"));
    console.log("shot", name, theme);
  }
}
killChrome(child, profile);
process.exit(0);
