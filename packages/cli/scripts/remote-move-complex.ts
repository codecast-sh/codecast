/**
 * Complex-case validation of move-to-remote (content-based diff checks).
 * Round-trip: local -> remote (responsive + diff present) -> change on remote
 * -> pull back (change round-tripped, responsive local) -> remote again.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import {
  pushSession, pullSession, remotePrompt, resolveLocalSession, type RemoteHost,
} from "../src/remote/session-move.js";

const HOST: RemoteHost = {
  address: "51.159.120.28", user: "m1",
  keyPath: `${process.env.HOME}/.codecast/scaleway/d7_id_ed25519`,
  remoteBaseDir: "/Users/m1/work",
};
const j = (o: string) => { try { return JSON.parse(o); } catch { return { result: o.slice(0, 160) }; } };
const ssh = (cmd: string) => execFileSync("ssh", ["-i", HOST.keyPath, "-o", "StrictHostKeyChecking=accept-new", `${HOST.user}@${HOST.address}`, cmd], { encoding: "utf-8" });

const sessionId = process.argv[2];
const s = resolveLocalSession(sessionId);
console.log(`session ${sessionId}\n  local cwd=${s.cwd}`);

console.log("\n=== [1] PUSH to remote ===");
const mv = pushSession(sessionId, HOST);
console.log(`  -> ${HOST.user}@${HOST.address}:${mv.remoteCwd}`);

console.log("\n=== [2] code diff present on remote? (file content) ===");
const demo = ssh(`cat ${mv.remoteCwd}/DEMO_CHANGE.txt 2>&1`).trim();
const marker = ssh(`grep -c REMOTE_MOVE_DEMO ${mv.remoteCwd}/packages/cli/src/index.ts 2>&1`).trim();
console.log(`  DEMO_CHANGE.txt on remote: ${JSON.stringify(demo)}`);
console.log(`  index.ts marker lines on remote: ${marker}`);

console.log("\n=== [3] remote responsive + recalls codeword GIRAFFE? ===");
console.log("  remote:", JSON.stringify(j(remotePrompt(HOST, mv.remoteCwd, sessionId, "What codeword did I give you? one word")).result?.slice(0, 60)));

console.log("\n=== [4] change ON remote via the session ===");
console.log("  remote:", JSON.stringify(j(remotePrompt(HOST, mv.remoteCwd, sessionId,
  "Append a line 'remote-change-v2' to DEMO_CHANGE.txt (use a shell command). Reply DONE.")).result?.slice(0, 60)));
const afterRemote = ssh(`cat ${mv.remoteCwd}/DEMO_CHANGE.txt 2>&1`).trim();
console.log(`  DEMO_CHANGE.txt on remote now: ${JSON.stringify(afterRemote)}`);

console.log("\n=== [5] PULL back to local ===");
pullSession(sessionId, HOST, mv);
const localDemo = fs.readFileSync(`${s.cwd}/DEMO_CHANGE.txt`, "utf-8").trim();
console.log(`  DEMO_CHANGE.txt locally after pull: ${JSON.stringify(localDemo)}`);
console.log(`  remote change round-tripped: ${localDemo.includes("remote-change-v2")}`);

console.log("\n=== [6] local responsive after pull? ===");
console.log("  local:", JSON.stringify(j(execFileSync("claude",
  ["-p", "--resume", sessionId, "In under 10 words: what file did we change and the codeword?", "--output-format", "json"],
  { cwd: s.cwd, encoding: "utf-8", input: "" })).result?.slice(0, 100)));

console.log("\n=== [7] PUSH to remote AGAIN (back-and-forth) ===");
const mv2 = pushSession(sessionId, HOST);
console.log("  remote(2nd):", JSON.stringify(j(remotePrompt(HOST, mv2.remoteCwd, sessionId, "still tracking our work? YES/NO")).result?.slice(0, 30)));

console.log("\n✓ complex move round-trip complete");
