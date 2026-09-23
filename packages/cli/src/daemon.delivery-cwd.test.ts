import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { conversationNamesRepo, noLocalCheckoutError, placeFreshDeliverySession } from "./daemon.js";
import { resolveResumeCwd } from "./projectPathResolver.js";

// 2026-09-22: a session that had run for three hours in /Users/ashot/src/codecast
// on the Mac was taken over by the Linux box when the Mac looked offline for two
// minutes. The box had a checkout of the same remote at /home/ubuntu/work/codecast,
// but both the rebuild (regenerationCwd) and the delivery fallback
// (startFreshSessionForDelivery) checked only fs.existsSync(project_path), found
// nothing, and the fallback started claude in $HOME. The server row then read
// project_path=/home/ubuntu, and moving the session back to the Mac refused it
// with "recorded path unknown". Both decisions now go through the resume
// resolver (git remote, then convention), and $HOME is only for a conversation
// that names no project at all.

const MAC = "/Users/ashot/src/codecast";
const LINUX = "/home/ubuntu/work/codecast";
const LINUX_HOME = "/home/ubuntu";
const REMOTE = "git@github.com:codecast-sh/codecast.git";
const conversation = { project_path: MAC, git_root: MAC, git_remote_url: REMOTE };
const onLinux = (p: string) => p === LINUX || p === LINUX_HOME || p === `${LINUX}/packages/cli`;
const noConvention = () => null;

describe("delivery on a machine that lacks the recorded project path", () => {
  test("a foreign project_path with a checkout of the same remote resolves to that checkout", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: MAC,
      recordedRoot: MAC,
      resolveLocalRepo: noConvention,
      remapViaRemote: async () => LINUX,
      exists: onLinux,
    });
    expect(cwd).toBe(LINUX);
    expect(placeFreshDeliverySession({ resolvedCwd: cwd, conversation, isRemote: false, home: LINUX_HOME }))
      .toEqual({ kind: "run", cwd: LINUX });
  });

  test("a foreign subpath is placed under the local checkout by the recorded root seed", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: `${MAC}/packages/cli`,
      recordedRoot: MAC,
      // The convention resolver is asked about the ROOT, whose basename is the repo.
      resolveLocalRepo: (p) => (p === MAC ? LINUX : null),
      exists: onLinux,
    });
    expect(cwd).toBe(`${LINUX}/packages/cli`);
  });

  test("a foreign path with no checkout refuses with the banner and never yields $HOME", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: MAC,
      recordedRoot: MAC,
      resolveLocalRepo: noConvention,
      remapViaRemote: async () => null,
      exists: (p) => p === LINUX_HOME,
    });
    expect(cwd).toBeNull();
    const placement = placeFreshDeliverySession({ resolvedCwd: cwd, conversation, isRemote: false, home: LINUX_HOME });
    expect(placement).toEqual({ kind: "refuse", reason: "no_local_checkout" });
    expect(noLocalCheckoutError(REMOTE, MAC)).toBe(
      `No local checkout for ${REMOTE} (recorded path ${MAC} doesn't exist here). Clone it first.`,
    );
  });

  test("a conversation that names only a remote is still a repo, not a quick-create", () => {
    const placement = placeFreshDeliverySession({
      resolvedCwd: null,
      conversation: { project_path: null, git_root: null, git_remote_url: REMOTE },
      isRemote: false,
      home: LINUX_HOME,
    });
    expect(placement).toEqual({ kind: "refuse", reason: "no_local_checkout" });
  });

  test("a conversation with no repo information gets $HOME on a local device", () => {
    for (const blank of [null, undefined, {}, { project_path: null, git_root: null, git_remote_url: null }]) {
      expect(placeFreshDeliverySession({ resolvedCwd: null, conversation: blank, isRemote: false, home: LINUX_HOME }))
        .toEqual({ kind: "run", cwd: LINUX_HOME });
    }
  });

  test("a conversation with no repo information is refused on a remote device", () => {
    expect(placeFreshDeliverySession({ resolvedCwd: null, conversation: {}, isRemote: true, home: "/Users/m1" }))
      .toEqual({ kind: "refuse", reason: "remote_no_project" });
  });
});

describe("conversationNamesRepo", () => {
  test("a path, a root, or a remote each name a repo", () => {
    expect(conversationNamesRepo({ project_path: MAC })).toBe(true);
    expect(conversationNamesRepo({ git_root: MAC })).toBe(true);
    expect(conversationNamesRepo({ git_remote_url: REMOTE })).toBe(true);
  });

  test("nothing, blanks, or a bare filesystem root name none", () => {
    expect(conversationNamesRepo(null)).toBe(false);
    expect(conversationNamesRepo({ project_path: "", git_root: " ", git_remote_url: "" })).toBe(false);
    // A rollout regenerated under the daemon records cwd `/` (isResumableCwd).
    expect(conversationNamesRepo({ project_path: "/" })).toBe(false);
  });
});

// Source invariants: the two cwd decisions must stay on the resolver. These
// read daemon.ts text and do not execute the daemon.
const daemonSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts"),
  "utf8",
);

describe("delivery cwd invariants", () => {
  test("startFreshSessionForDelivery places the session through the resolver, then the placement rule", () => {
    const start = daemonSource.indexOf("async function startFreshSessionForDelivery");
    expect(start).toBeGreaterThan(-1);
    const body = daemonSource.slice(start, start + 8000);
    expect(body).toContain("projectPath = await regenerationCwd(exportData)");
    expect(body).not.toContain("fs.existsSync(exportData.conversation.project_path)");
    const placeIdx = body.indexOf("placeFreshDeliverySession(");
    expect(placeIdx).toBeGreaterThan(-1);
    expect(body.indexOf("refuseResumeNoLocalCheckout(")).toBeGreaterThan(placeIdx);
    // The placement decision precedes the spawn.
    expect(placeIdx).toBeLessThan(body.indexOf("new-session"));
  });

  test("regenerationCwd is the resume resolver, not an existence check", () => {
    const start = daemonSource.indexOf("async function regenerationCwd");
    expect(start).toBeGreaterThan(-1);
    const body = daemonSource.slice(start, start + 600);
    expect(body).toContain("resolveResumeCwdOrRefuse(");
    expect(body).not.toContain("existsSync");
  });
});
