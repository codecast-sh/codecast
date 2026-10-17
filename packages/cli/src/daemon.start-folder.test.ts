// A new session started in a folder the machine lacks gets that folder only
// when it is a plain folder inside home; a recorded repo or a foreign path
// keeps the refusal banner.
import { describe, expect, test } from "bun:test";
import { creatableStartFolder } from "./daemon";

const home = "/Users/ada";
const plain = { git_root: null, git_remote_url: null };

describe("creatableStartFolder", () => {
  test("a plain folder inside home is created", () => {
    expect(creatableStartFolder("/Users/ada/src/aurora", home, plain)).toBe("/Users/ada/src/aurora");
    expect(creatableStartFolder("/Users/ada/src/new/sub/", home, null)).toBe("/Users/ada/src/new/sub");
    // The new-session pickers stamp git_root = the folder itself.
    expect(creatableStartFolder("/Users/ada/src/aurora", home, { git_root: "/Users/ada/src/aurora", git_remote_url: null })).toBe("/Users/ada/src/aurora");
  });

  test("a recorded repo is cloned, not invented", () => {
    expect(creatableStartFolder("/Users/ada/src/x/web", home, { git_root: "/Users/ada/src/x", git_remote_url: null })).toBeNull();
    expect(creatableStartFolder("/Users/ada/src/x", home, { git_root: null, git_remote_url: "git@github.com:a/x.git" })).toBeNull();
  });

  test("paths outside home, home itself, relative or unsafe paths are refused", () => {
    expect(creatableStartFolder("/Users/bob/src/x", home, plain)).toBeNull();
    expect(creatableStartFolder("/Users/adam/src/x", home, plain)).toBeNull();
    expect(creatableStartFolder("/Users/ada", home, plain)).toBeNull();
    expect(creatableStartFolder("/Users/ada/../bob/x", home, plain)).toBeNull();
    expect(creatableStartFolder("src/x", home, plain)).toBeNull();
    expect(creatableStartFolder("/Users/ada/src/$(rm)", home, plain)).toBeNull();
    expect(creatableStartFolder("/Users/ada/src/x", undefined, plain)).toBeNull();
  });
});
