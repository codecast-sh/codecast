import { describe, expect, test } from "bun:test";
import { reorientationNotice, reparentNotice } from "./sessionMoveNotice.js";

const base = { destination: "macOS - m1", newCwd: "/Users/sam/.codecast/reparented/app-1a2b3c4d", machineChanged: true };

describe("reorientationNotice", () => {
  test("says nothing when nothing material changed", () => {
    expect(
      reorientationNotice({ destination: "macOS - m1", newCwd: "/repo", machineChanged: false }),
    ).toBeNull();
    // Same path, same machine, no clone, no account change: silence.
    expect(
      reorientationNotice({ destination: "macOS - m1", newCwd: "/repo", oldCwd: "/repo", machineChanged: false }),
    ).toBeNull();
  });

  test("a same-machine move reports the directory, not a machine change", () => {
    const n = reorientationNotice({
      destination: "macOS - m1", newCwd: "/repo/b", oldCwd: "/repo/a", machineChanged: false,
    })!;
    expect(n).toContain("moved to a different directory");
    expect(n).not.toContain("different machine");
    // The machine-scoped warning is a machine-change fact — it must not appear.
    expect(n).not.toContain("Processes, ports");
  });

  test("a fresh clone warns that only pushed work is here, and names the branch", () => {
    const n = reorientationNotice({
      ...base,
      oldCwd: "/Users/ashot/src/app on macOS - laptop",
      checkout: { cwd: base.newCwd, cloned: true, remote: "git@github.com:acme/app.git", branch: "main" },
    })!;
    expect(n).toContain("fresh clone");
    expect(n).toContain("git@github.com:acme/app.git");
    expect(n).toContain("branch main");
    expect(n).toContain("committed but not pushed");
    expect(n).toContain("If you were on a different branch, you are not on it now");
    expect(n).toContain("(previously /Users/ashot/src/app on macOS - laptop)");
  });

  test("a reused checkout does NOT claim only-pushed-work — it is a different world", () => {
    const n = reorientationNotice({
      ...base,
      checkout: { cwd: base.newCwd, cloned: false, branch: "feature" },
    })!;
    expect(n).toContain("already existed on this machine");
    expect(n).not.toContain("fresh clone");
    expect(n).not.toContain("Only work that was pushed");
  });

  test("crossing accounts names whose config applies and what did not travel", () => {
    const n = reorientationNotice({
      ...base,
      checkout: { cwd: base.newCwd, cloned: true, branch: "main" },
      account: { fromUser: "Ashot", toUser: "Samvit" },
    })!;
    expect(n).toContain("under Samvit's account, not Ashot's");
    expect(n).toContain("belongs to Samvit");
    expect(n).toContain("your personal config did not travel");
    // Project rules DO travel with the repo — the agent must not assume otherwise.
    expect(n).toContain("CLAUDE.md and AGENTS.md came with the repo");
    expect(n).toContain("Credentials here are Samvit's");
  });

  test("a same-user move stays silent about accounts", () => {
    const n = reorientationNotice({ ...base, checkout: { cwd: base.newCwd, cloned: true } })!;
    expect(n).not.toContain("account");
    expect(n).not.toContain("did not travel");
  });

  test("never mentions the transcript — the import notice already discloses the trim", () => {
    const n = reorientationNotice({
      ...base,
      checkout: { cwd: base.newCwd, cloned: true, branch: "main" },
      account: { fromUser: "Ashot", toUser: "Samvit" },
    })!;
    expect(n.toLowerCase()).not.toContain("transcript");
    expect(n.toLowerCase()).not.toContain("trimmed");
  });

  test("always closes by asking the agent to re-ground", () => {
    const n = reorientationNotice({ ...base, checkout: { cwd: base.newCwd, cloned: true } })!;
    expect(n).toContain("re-ground yourself");
    expect(n).toContain("say so instead of proceeding");
  });

  test("degrades honestly when the branch or remote could not be read", () => {
    const n = reorientationNotice({ ...base, checkout: { cwd: base.newCwd, cloned: true } })!;
    expect(n).toContain("fresh clone");
    // No invented branch/remote names, and no dangling connectives.
    expect(n).not.toContain("undefined");
    expect(n).not.toContain("branch .");
    expect(n).not.toContain(" of  ");
  });

  test("the SSH move shape: verification is reported, no checkout surprises", () => {
    const n = reorientationNotice({
      destination: "m1@51.159.120.28",
      newCwd: "/Users/m1/src/app",
      oldCwd: "/Users/ashot/src/app on laptop",
      machineChanged: true,
      verification: "branch main at 1a2b3c4d, destination HEAD matches, clean working tree",
    })!;
    expect(n).toContain("Verification: branch main at 1a2b3c4d");
    expect(n).toContain("wip snapshot");
    // The SSH move pushed the tree itself, so no clone warning belongs here.
    expect(n).not.toContain("fresh clone");
    expect(n).toContain("Processes, ports");
  });
});

// What the daemon actually runs: the resume_session args exactly as
// reparentSessionToDevice (devices.ts) emits them, plus what this machine found
// when it prepared the checkout. Kept in step with devices.reparent.test.ts.
describe("reparentNotice (daemon mapping)", () => {
  const clone = { cwd: "/Users/samvit/.codecast/reparented/app-1a2b", cloned: true, remote: "git@github.com:acme/app.git", branch: "main" };

  test("the cross-account payload produces the full account warning", () => {
    const n = reparentNotice({
      destinationLabel: "macOS - samvit-mbp",
      priorCwd: "/Users/ashot/src/app",
      checkout: clone,
      command: {
        reparented: true, device_changed: true, from_device: "macOS - ashot-laptop",
        cross_user: true, from_user: "Ashot", to_user: "Samvit",
      } as any,
    })!;
    expect(n).toContain("macOS - samvit-mbp");
    expect(n).toContain("(previously /Users/ashot/src/app on macOS - ashot-laptop)");
    expect(n).toContain("under Samvit's account, not Ashot's");
    expect(n).toContain("fresh clone");
  });

  test("the same-user payload omits account facts entirely", () => {
    const n = reparentNotice({
      destinationLabel: "macOS - m1",
      priorCwd: "/Users/ashot/src/app",
      checkout: clone,
      command: { reparented: true, device_changed: true, from_device: "macOS - laptop" } as any,
    })!;
    expect(n).not.toContain("account");
    expect(n).toContain("fresh clone");
  });

  test("device_changed:false reports a directory move, not a machine move", () => {
    const n = reparentNotice({
      destinationLabel: "macOS - m1",
      priorCwd: "/Users/ashot/src/app",
      checkout: { cwd: "/Users/ashot/.codecast/reparented/app-1a2b", cloned: true },
      command: { reparented: true, device_changed: false } as any,
    })!;
    expect(n).toContain("moved to a different directory");
    expect(n).not.toContain("different machine");
  });

  test("an older server that sends no facts still gets a machine-move notice", () => {
    // Back-compat: reparented:true alone. Absent device_changed means changed —
    // a reparent is a machine move by construction.
    const n = reparentNotice({
      destinationLabel: "macOS - m1",
      priorCwd: "/Users/ashot/src/app",
      checkout: clone,
      command: { reparented: true } as any,
    })!;
    expect(n).toContain("moved to a different machine");
    expect(n).toContain("fresh clone");
    expect(n).not.toContain("account");
    // No from_device: name the path alone rather than inventing a machine.
    expect(n).toContain("(previously /Users/ashot/src/app)");
  });

  test("garbage in the payload is coerced, never interpolated", () => {
    const n = reparentNotice({
      destinationLabel: "macOS - m1",
      priorCwd: "/Users/ashot/src/app",
      checkout: clone,
      command: { cross_user: "yes", from_user: 42, to_user: null, from_device: {} } as any,
    })!;
    // cross_user must be strictly true — a truthy string is not consent to
    // claim the account changed hands.
    expect(n).not.toContain("account");
    expect(n).not.toContain("42");
    expect(n).not.toContain("[object Object]");
  });

  test("a cross-user payload with unknown names still warns, without naming", () => {
    const n = reparentNotice({
      destinationLabel: "macOS - x",
      checkout: clone,
      command: { cross_user: true } as any,
    })!;
    expect(n).toContain("another user's account");
    expect(n).toContain("did not travel");
    expect(n).not.toContain("undefined");
  });

  test("nothing to say without a cwd", () => {
    expect(reparentNotice({ destinationLabel: "macOS - m1", command: {} })).toBeNull();
  });
});
