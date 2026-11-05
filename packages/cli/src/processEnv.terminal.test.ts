import { describe, expect, test } from "bun:test";
import { terminalProgramForApp, terminalProgramOnTty } from "./processEnv.js";

// Shapes seen on macOS (2026-11-05): Ghostty opens a tty with a root-owned
// login, whose environment is unreadable, then the shell, then the agent.
const rows: Record<number, { ppid: number; tty: string; comm: string }> = {
  18512: { ppid: 1, tty: "??", comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
  29738: { ppid: 18512, tty: "ttys091", comm: "/usr/bin/login" },
  29790: { ppid: 29738, tty: "ttys091", comm: "-/bin/bash" },
  29855: { ppid: 29790, tty: "ttys091", comm: "pi" },
  700: { ppid: 1, tty: "??", comm: "tmux" },
  701: { ppid: 700, tty: "ttys005", comm: "-zsh" },
  702: { ppid: 701, tty: "ttys005", comm: "codex" },
  900: { ppid: 1, tty: "??", comm: "codex" },
};
const row = async (pid: number) => rows[pid] ?? null;
const noEnv = () => null;

describe("terminalProgramOnTty", () => {
  test("reads TERM_PROGRAM from the process's own environment first", async () => {
    expect(await terminalProgramOnTty(29855, () => ({ TERM_PROGRAM: "iTerm.app" }), row)).toBe("iTerm.app");
  });

  // pi renames its process, which wipes the env it was exec'd with, and macOS
  // hides /bin/bash's: the app that opened the tty still names the terminal.
  test("names the app that owns the tty when no environment can be read", async () => {
    expect(await terminalProgramOnTty(29855, noEnv, row)).toBe("ghostty");
  });

  test("a tmux pane is tmux, never the terminal tmux was started from", async () => {
    expect(await terminalProgramOnTty(702, noEnv, row)).toBe("tmux");
  });

  test("a process with no terminal has none", async () => {
    expect(await terminalProgramOnTty(900, noEnv, row)).toBeUndefined();
  });
});

test("terminalProgramForApp maps each terminal app to its TERM_PROGRAM", () => {
  expect(terminalProgramForApp("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toBe("ghostty");
  expect(terminalProgramForApp("/Applications/iTerm.app/Contents/MacOS/iTermServer-3.6.6")).toBe("iTerm.app");
  expect(terminalProgramForApp("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")).toBe("Apple_Terminal");
  expect(terminalProgramForApp("/Applications/kitty.app/Contents/MacOS/kitty")).toBe("kitty");
  expect(terminalProgramForApp("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")).toBe("WezTerm");
  expect(terminalProgramForApp("launchd")).toBeUndefined();
});
