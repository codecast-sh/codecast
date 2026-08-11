import { describe, test, expect } from "bun:test";
import { attachCommand } from "./tmuxAttach";

const mine = (ssh_host: string | null) => ({
  device_id: "d1",
  label: "Linux - nose",
  platform: "linux",
  is_remote: false,
  is_mine: true,
  ssh_host,
});

const theirs = {
  device_id: "965fa002dd353cd5",
  label: "macOS - Mac-mini",
  platform: "darwin",
  is_remote: false,
  is_mine: false,
  ssh_host: null,
};

describe("attachCommand", () => {
  test("your machine with an ssh host: wraps the attach for a remote shell", () => {
    expect(attachCommand("cc-resume-7ea05201", mine("nose"))).toBe(
      `ssh nose -t "tmux attach -t 'cc-resume-7ea05201'"`,
    );
  });

  // Without -t, ssh allocates no TTY and tmux exits with
  // "open terminal failed: not a terminal" — the bug in remote/cli.ts:287.
  test("the ssh form forces a TTY", () => {
    expect(attachCommand("cc-x", mine("nose"))).toContain("ssh nose -t ");
  });

  // Inner single quotes are spent on the pane name, so the outer layer the
  // remote shell re-parses must be double quotes.
  test("quoting nests rather than collides", () => {
    const cmd = attachCommand("cc-x", mine("m1@10.0.0.4"))!;
    expect(cmd).toBe(`ssh m1@10.0.0.4 -t "tmux attach -t 'cc-x'"`);
    expect(cmd.match(/"/g)).toHaveLength(2);
    expect(cmd.match(/'/g)).toHaveLength(2);
  });

  test("your machine with no ssh host: the plain local command", () => {
    expect(attachCommand("cc-x", mine(null))).toBe("tmux attach -t 'cc-x'");
  });

  // The whole point: a pane on a machine that isn't yours has no command that
  // could work, so the pill must offer none rather than one that always fails.
  test("someone else's machine yields no command at all", () => {
    expect(attachCommand("cc-resume-7ea05201", theirs)).toBeNull();
  });

  test("unknown machine falls back to the pre-existing local form", () => {
    expect(attachCommand("cc-x", null)).toBe("tmux attach -t 'cc-x'");
    expect(attachCommand("cc-x", undefined)).toBe("tmux attach -t 'cc-x'");
  });
});
