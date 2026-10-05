import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fenceAdmits, fenceTargetOf, isTrackedLineProfile, realTargetOf } from "./configFence";

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fence-")));
  const home = path.join(base, "home");
  const repo = path.join(base, "src", "repo");
  const other = path.join(base, "src", "other");
  for (const d of [path.join(home, ".claude"), path.join(repo, ".codecast"), path.join(repo, "sub", ".codecast"), path.join(other, ".codecast")]) fs.mkdirSync(d, { recursive: true });
  return { base, home, repo, other, roots: [repo] };
}

const admits = (w: ReturnType<typeof world>, p: string, kind?: "config" | "line_profile" | "read") => {
  const real = fenceTargetOf(p);
  return !!real && fenceAdmits(real, { home: w.home, roots: w.roots, kind });
};

describe("line profile", () => {
  test("a tracked root's .codecast/line.toml is admitted for line_profile and read, never for config_write", () => {
    const w = world();
    expect(admits(w, path.join(w.repo, ".codecast/line.toml"), "line_profile")).toBe(true);
    expect(admits(w, path.join(w.repo, ".codecast/line.toml"), "read")).toBe(true);
    // config_write skips the loader, the base check and the republish: line_profile_edit is the one writer.
    expect(admits(w, path.join(w.repo, ".codecast/line.toml"))).toBe(false);
    expect(admits(w, path.join(w.repo, ".codecast/line.toml"), "config")).toBe(false);
    // A package's own profile inside the tracked checkout (findLineProfile walks up to it).
    expect(admits(w, path.join(w.repo, "sub/.codecast/line.toml"), "line_profile")).toBe(true);
  });

  test("an untracked repo's profile is refused", () => {
    const w = world();
    expect(admits(w, path.join(w.other, ".codecast/line.toml"), "line_profile")).toBe(false);
  });

  test("line_profile admits nothing but the profile", () => {
    const w = world();
    expect(admits(w, path.join(w.repo, "CLAUDE.md"), "line_profile")).toBe(false);
    expect(admits(w, path.join(w.home, ".claude/settings.json"), "line_profile")).toBe(false);
    expect(admits(w, path.join(w.repo, ".codecast/workspace.toml"), "line_profile")).toBe(false);
    expect(admits(w, path.join(w.repo, ".codecast/line.toml.bak"), "line_profile")).toBe(false);
    expect(admits(w, path.join(w.repo, "notline.toml"), "line_profile")).toBe(false);
  });

  test("a symlinked .codecast pointing outside the root is refused", () => {
    const w = world();
    const evil = path.join(w.base, "evil");
    fs.mkdirSync(path.join(evil), { recursive: true });
    fs.rmSync(path.join(w.repo, "sub", ".codecast"), { recursive: true });
    fs.symlinkSync(path.join(w.other, ".codecast"), path.join(w.repo, "sub", ".codecast"));
    expect(admits(w, path.join(w.repo, "sub/.codecast/line.toml"), "line_profile")).toBe(false);
  });

  test("a tracked line.toml that is a symlink to a file outside the root is refused for every kind", () => {
    const w = world();
    const outside = path.join(w.base, "outside.toml");
    fs.writeFileSync(outside, "# not the repo's\n");
    fs.symlinkSync(outside, path.join(w.repo, ".codecast/line.toml"));
    for (const kind of ["config", "line_profile", "read"] as const) expect(admits(w, path.join(w.repo, ".codecast/line.toml"), kind)).toBe(false);
  });

  test("read admits an agent config basename outside tracked roots; config_write does not", () => {
    const w = world();
    expect(admits(w, path.join(w.other, "CLAUDE.md"), "read")).toBe(true);
    expect(admits(w, path.join(w.other, "CLAUDE.md"), "config")).toBe(false);
    expect(admits(w, path.join(w.other, "secrets.env"), "read")).toBe(false);
  });

  test("a ../ walk out of the root is resolved before the check", () => {
    const w = world();
    expect(admits(w, path.join(w.repo, "..", "other", ".codecast/line.toml"), "line_profile")).toBe(false);
  });

  test("a .codecast directory that does not exist yet still resolves (file creation)", () => {
    const w = world();
    const fresh = path.join(w.base, "src", "fresh");
    fs.mkdirSync(fresh);
    expect(admits({ ...w, roots: [fresh] }, path.join(fresh, ".codecast/line.toml"), "line_profile")).toBe(true);
  });

  test("a symlinked root matches its own files", () => {
    const w = world();
    const link = path.join(w.base, "repo-link");
    fs.symlinkSync(w.repo, link);
    expect(isTrackedLineProfile(realTargetOf(path.join(link, ".codecast/line.toml"))!, [link])).toBe(true);
  });
});

describe("config files keep their old rules", () => {
  test("own ~/.claude subtree and tracked-project agent config basenames", () => {
    const w = world();
    expect(admits(w, path.join(w.home, ".claude/settings.json"))).toBe(true);
    expect(admits(w, path.join(w.home, ".claude/agents/x.md"))).toBe(true);
    expect(admits(w, path.join(w.repo, "CLAUDE.md"))).toBe(true);
    expect(admits(w, path.join(w.repo, ".mcp.json"))).toBe(true);
  });

  test("anything else is refused", () => {
    const w = world();
    expect(admits(w, path.join(w.repo, "package.json"))).toBe(false);
    expect(admits(w, path.join(w.other, "CLAUDE.md"))).toBe(false);
    expect(admits(w, path.join(w.base, "someone", ".claude", "settings.json"))).toBe(false);
  });
});

test("a line profile that is itself a symlink is judged by what it names", () => {
  const w = world();
  const outside = path.join(w.base, "outside.toml");
  fs.writeFileSync(outside, "[line]\n");
  fs.symlinkSync(outside, path.join(w.repo, ".codecast/line.toml"));
  expect(fenceAdmits(realTargetOf(path.join(w.repo, ".codecast/line.toml"), { followFile: true })!, { home: w.home, roots: w.roots, kind: "line_profile" })).toBe(false);
  // Without followFile the config rule keeps a dotfiles-linked settings.json writable by its own name.
  const dot = path.join(w.base, "dotfiles-settings.json");
  fs.writeFileSync(dot, "{}");
  fs.symlinkSync(dot, path.join(w.home, ".claude/settings.json"));
  expect(admits(w, path.join(w.home, ".claude/settings.json"))).toBe(true);
});
