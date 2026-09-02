import { describe, test, expect } from "bun:test";
import { attachCommand, attachCopy, REMOTE_TMUX_PATH } from "./tmuxAttach";

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
      `ssh nose -t "PATH=${REMOTE_TMUX_PATH} tmux attach -t 'cc-resume-7ea05201'"`,
    );
  });

  // `ssh host "cmd"` is a non-login shell: no .zprofile, so no Homebrew on
  // PATH, so no tmux on a stock Mac. The command has to bring its own PATH.
  test("the ssh form names where tmux lives, since the remote shell won't", () => {
    const cmd = attachCommand("cc-x", mine("nose"))!;
    expect(cmd).toContain("PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin tmux attach");
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
    expect(cmd).toBe(`ssh m1@10.0.0.4 -t "PATH=${REMOTE_TMUX_PATH} tmux attach -t 'cc-x'"`);
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

// The copy gesture end to end: what lands on the clipboard AND what the user is
// told. The bare local form is only valid in a shell on the pane's machine, and
// a session that was just pulled from a remote box still reads as "remote" to
// the person who pulled it — so a copy names the machine, and a foreign pane
// explains itself instead of doing nothing (the bug: a silent click).
describe("attachCopy", () => {
  test("your machine, no ssh host: local command, and the toast names the machine", () => {
    const c = attachCopy("cc-resume-7974cafd", { ...mine(null), label: "macOS - MacBook-Pro-168", platform: "darwin" });
    expect(c.command).toBe("tmux attach -t 'cc-resume-7974cafd'");
    expect(c.message).toContain("MacBook-Pro-168");
  });

  test("your machine with an ssh host: the ssh form, plainly labelled", () => {
    const c = attachCopy("cc-x", mine("nose"));
    expect(c.command).toBe(`ssh nose -t "PATH=${REMOTE_TMUX_PATH} tmux attach -t 'cc-x'"`);
    expect(c.message).toBe("ssh + tmux attach copied");
  });

  test("someone else's machine: no command, and the message says where it runs and how to bring it here", () => {
    const c = attachCopy("cc-x", theirs);
    expect(c.command).toBeNull();
    expect(c.message).toContain("Mac-mini");
    expect(c.message).toContain("run here");
  });

  test("unknown machine: the pre-existing local form with the plain toast", () => {
    expect(attachCopy("cc-x", null)).toEqual({ command: "tmux attach -t 'cc-x'", message: "tmux attach copied" });
  });
});
