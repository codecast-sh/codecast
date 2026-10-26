import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { adoptManagedBinary, isManagedInstall } from "./managedInstall";
import { installChannel } from "./update";

describe("isManagedInstall", () => {
  test("a root-owned binary is managed, a user-owned one is not", () => {
    expect(isManagedInstall("/x/codecast", () => ({ uid: 0 }), "darwin")).toBe(true);
    expect(isManagedInstall("/x/codecast", () => ({ uid: 501 }), "darwin")).toBe(false);
    expect(isManagedInstall("/x/codecast", () => ({ uid: 0 }), "win32")).toBe(false);
    expect(isManagedInstall("/x/codecast", () => { throw new Error("ENOENT"); }, "linux")).toBe(false);
  });

  test("a managed binary in a writable folder still cannot self-update", () => {
    const ch = installChannel("/usr/local/bin/codecast", false, () => true, () => true);
    expect(ch).toEqual({ distribution: "installer", can_self_update: false });
    expect(installChannel("/Users/a/.local/bin/codecast", false, () => true, () => false).can_self_update).toBe(true);
  });
});

describe("adoptManagedBinary", () => {
  test("does nothing unless the managed binary is root-owned", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mdm-adopt-"));
    const managed = path.join(home, "managed-codecast");
    fs.writeFileSync(managed, "x");
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local/bin/codecast"), "old");
    expect(adoptManagedBinary(home, managed)).toEqual([]);
    expect(fs.lstatSync(path.join(home, ".local/bin/codecast")).isSymbolicLink()).toBe(false);
  });

  test("replaces per-user copies with symlinks to a root-owned binary, once", () => {
    // /bin/sh is root-owned on every Mac and Linux box: a stand-in for /usr/local/bin/codecast.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mdm-adopt-"));
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    const copy = path.join(home, ".local/bin/codecast");
    fs.writeFileSync(copy, "old");
    fs.symlinkSync("codecast", path.join(home, ".local/bin/cast"));
    expect(adoptManagedBinary(home, "/bin/sh")).toEqual([copy]);
    expect(fs.readlinkSync(copy)).toBe("/bin/sh");
    expect(fs.realpathSync(path.join(home, ".local/bin/cast"))).toBe(fs.realpathSync("/bin/sh"));
    expect(adoptManagedBinary(home, "/bin/sh")).toEqual([]);
  });
});
