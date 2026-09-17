import { describe, expect, test } from "bun:test";
import { cloudPlacementFor, deviceWakesOnUse, pathUnderRoot, platformCanOpenPath } from "./cloudPlacement";

const host = { platform: "linux", local_project_roots: ["/home/ubuntu/work/codecast"] };
const mac = { platform: "darwin", local_project_roots: ["/Users/me/src/app"] };
const linuxLaptop = { platform: "linux", local_project_roots: ["/home/me/code/app"] };

describe("cloudPlacementFor — one verdict for the web and the server", () => {
  test("a laptop folder on a Linux host parks (the laptop prepares the host)", () => {
    expect(cloudPlacementFor({ target: host, locals: [mac], paths: ["/Users/me/src/app"] })).toBe("park");
  });

  test("a worktree under the host's own roots is native", () => {
    expect(cloudPlacementFor({
      target: host, locals: [mac], paths: ["/home/ubuntu/work/codecast/.codecast/worktrees/x"],
    })).toBe("native");
    expect(cloudPlacementFor({ target: host, locals: [mac], paths: ["/home/ubuntu/work/codecast"] })).toBe("native");
  });

  test("a /home path that no Mac-only laptop could open is native even without host roots", () => {
    expect(cloudPlacementFor({ target: { platform: "linux" }, locals: [mac], paths: ["/home/ubuntu/work/x"] })).toBe("native");
  });

  test("a path nobody covers with a Linux laptop around is ambiguous", () => {
    expect(cloudPlacementFor({ target: host, locals: [linuxLaptop, mac], paths: ["/opt/thing"] })).toBe("ambiguous");
  });

  test("a path under a local root parks, even when the host could open it", () => {
    expect(cloudPlacementFor({ target: host, locals: [linuxLaptop], paths: ["/home/me/code/app/sub"] })).toBe("park");
  });

  test("no paths is ambiguous — a pathless eager row carries no evidence", () => {
    expect(cloudPlacementFor({ target: host, locals: [mac], paths: [] })).toBe("ambiguous");
    expect(cloudPlacementFor({ target: host, locals: [mac], paths: [null, undefined, ""] })).toBe("ambiguous");
  });

  test("with no local device only a host-root path is native; anything else parks or stays ambiguous", () => {
    expect(cloudPlacementFor({ target: host, locals: [], paths: ["/home/ubuntu/work/codecast/pkg"] })).toBe("native");
    expect(cloudPlacementFor({ target: host, locals: [], paths: ["/Users/me/src/app"] })).toBe("park");
    expect(cloudPlacementFor({ target: host, locals: [], paths: ["/opt/thing"] })).toBe("ambiguous");
  });

  test("the host root wins over a local root when both cover a path", () => {
    expect(cloudPlacementFor({
      target: { platform: "linux", local_project_roots: ["/home/me/code/app"] },
      locals: [linuxLaptop], paths: ["/home/me/code/app"],
    })).toBe("native");
  });

  test("git root and project path are both evidence", () => {
    expect(cloudPlacementFor({ target: host, locals: [mac], paths: ["/Users/me/src/app", "/Users/me/src/app/pkg"] })).toBe("park");
  });
});

describe("deviceWakesOnUse — the cloud Linux class", () => {
  test("true only for a remote Linux box", () => {
    expect(deviceWakesOnUse({ is_remote: true, platform: "linux" })).toBe(true);
    expect(deviceWakesOnUse({ is_remote: true, platform: "darwin" })).toBe(false);
    expect(deviceWakesOnUse({ is_remote: false, platform: "linux" })).toBe(false);
    expect(deviceWakesOnUse({ platform: "linux" })).toBe(false);
    expect(deviceWakesOnUse({ is_remote: true })).toBe(false);
  });
});

describe("path helpers", () => {
  test("pathUnderRoot is prefix-by-segment", () => {
    expect(pathUnderRoot("/a/b", "/a")).toBe(true);
    expect(pathUnderRoot("/a/b", "/a/")).toBe(true);
    expect(pathUnderRoot("/ab", "/a")).toBe(false);
    expect(pathUnderRoot("/a", "/a")).toBe(true);
  });
  test("platformCanOpenPath refuses only provably foreign namespaces", () => {
    expect(platformCanOpenPath("linux", "/Users/me")).toBe(false);
    expect(platformCanOpenPath("darwin", "/home/me")).toBe(false);
    expect(platformCanOpenPath("darwin", "/opt/x")).toBe(true);
    expect(platformCanOpenPath(undefined, "/Users/me")).toBe(true);
    expect(platformCanOpenPath("win32", "C:\\x")).toBe(true);
    expect(platformCanOpenPath("win32", "/home/x")).toBe(false);
  });
});
