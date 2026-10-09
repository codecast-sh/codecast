// The host half of bringing moments (learning-loop.md LL7): a repo's
// extractors and judges read for publishing, an extractor run the way a line
// station runs a script, and one daemon pass end to end against a fake server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "./proc.js";
import { pruneHostMoments, runExtractor, shadowDir, tickMoments, type MomentClaim } from "./momentsHost.js";
import { readPublishSet } from "./momentsCommand.js";

let root: string;
let data: string;
const prevData = process.env.XDG_DATA_HOME;

const EXTRACTOR = `// Conversations for the comms judge.
// quiet: 10m
// timeout: 20s
const input = JSON.parse(await Bun.stdin.text());
if (input.subject === "boom") { console.error("no such thread"); process.exit(3); }
console.log(JSON.stringify({
  refs: [{ label: "thread", id: input.subject }],
  blocks: [{ type: "message", direction: "in", channel: "sms", at: input.at, sender: "Dana", body: "Tuesday?" }],
}));
`;

const JUDGE = `---
moment: conversation
projects: Agent Quality
mode: live
---
Read the conversation and say where the agent broke what we expect.
`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "moments-repo-"));
  data = fs.mkdtempSync(path.join(os.tmpdir(), "moments-data-"));
  process.env.XDG_DATA_HOME = data;
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".codecast/moments"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codecast/judges"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codecast/moments/conversation.ts"), EXTRACTOR);
  fs.writeFileSync(path.join(root, ".codecast/moments/Bad Name.ts"), "");
  fs.writeFileSync(path.join(root, ".codecast/judges/comms.md"), JUDGE);
  fs.writeFileSync(path.join(root, ".codecast/judges/broken.md"), "no header");
});

afterAll(() => {
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const claim = (subject: string, storage: "host" | "codecast" = "host", timeout_ms = 20_000): MomentClaim => ({
  moment: `mo-${subject}`,
  source: "union-app",
  input: { kind: "conversation", subject, at: Date.parse("2026-10-09T14:00:00Z"), refs: {}, events: 2, moment: `mo-${subject}` },
  extractor: { path: ".codecast/moments/conversation.ts", root, version: "published", timeout_ms },
  storage,
});

describe("what a checkout publishes", () => {
  test("each extractor with its header and blob sha, each judge parsed, problems named", async () => {
    const set = await readPublishSet(root);
    const sha = spawnSync("git", ["hash-object", ".codecast/moments/conversation.ts"], { cwd: root, encoding: "utf8" }).stdout.trim();
    expect(set.extractors).toEqual([{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: sha, quiet_ms: 600_000, timeout_ms: 20_000 }]);
    expect(set.judges.map((j) => [j.name, j.moment, j.mode, j.projects])).toEqual([["comms", "conversation", "live", ["Agent Quality"]]]);
    expect(set.problems.some((p) => p.includes("Bad Name.ts"))).toBe(true);
    expect(set.problems.some((p) => p.includes("broken.md"))).toBe(true);
  }, 60_000);
});

describe("running an extractor", () => {
  test("its stdout is the moment, at the file's current version", async () => {
    const r = await runExtractor(claim("t_81"));
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.output!).refs).toEqual([{ label: "thread", id: "t_81" }]);
    expect(r.version).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  test("a failing extractor says why, in its own last words", async () => {
    const r = await runExtractor(claim("boom"));
    expect(r.error).toBe("the extractor exited 3: no such thread");
  }, 60_000);
});

describe("one daemon pass", () => {
  test("claims, extracts, keeps a host body here, and hands the output back", async () => {
    const posts: Array<{ route: string; body: any }> = [];
    const results = await tickMoments({
      deviceId: "dev-1",
      post: async (route, body) => {
        posts.push({ route, body });
        if (route === "/cli/moments/claim") return [claim("t_81"), claim("boom", "codecast")];
        return { moment: body.moment, status: body.output ? "ready" : "waiting", ...(body.error ? { error: body.error } : {}) };
      },
    });
    expect(results).toEqual([
      { moment: "mo-t_81", status: "ready" },
      { moment: "mo-boom", status: "waiting", error: "the extractor exited 3: no such thread" },
    ]);
    const completes = posts.filter((p) => p.route === "/cli/moments/complete");
    expect(completes[0].body).toMatchObject({ device_id: "dev-1", moment: "mo-t_81" });
    expect(JSON.parse(completes[0].body.output).blocks).toHaveLength(1);
    const kept = path.join(shadowDir(), "union-app", "mo-t_81.json");
    expect(shadowDir().startsWith(data)).toBe(true);
    expect(JSON.parse(fs.readFileSync(kept, "utf8")).output.refs[0].id).toBe("t_81");
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
    // A codecast-stored claim is never written on the host.
    expect(fs.existsSync(path.join(shadowDir(), "union-app", "mo-boom.json"))).toBe(false);
  }, 60_000);

  test("host bodies past 30 days are pruned", () => {
    const kept = path.join(shadowDir(), "union-app", "mo-t_81.json");
    const old = (Date.now() - 31 * 24 * 60 * 60_000) / 1000;
    fs.utimesSync(kept, old, old);
    expect(pruneHostMoments(Date.now())).toBe(1);
    expect(fs.existsSync(kept)).toBe(false);
  });
});
