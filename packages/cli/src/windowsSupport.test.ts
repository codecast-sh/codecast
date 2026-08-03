import { describe, expect, it } from "bun:test";
import { buildWslAutostartTaskRun, daemonSupportedOnPlatform } from "./windowsSupport.js";

describe("buildWslAutostartTaskRun", () => {
  it("builds the hidden PowerShell + wsl.exe command", () => {
    expect(buildWslAutostartTaskRun("Ubuntu", "ashot", "/home/ashot/.local/bin/codecast")).toBe(
      "powershell.exe -NoProfile -WindowStyle Hidden -Command wsl.exe -d Ubuntu -u ashot -- /home/ashot/.local/bin/codecast start",
    );
  });

  it("accepts distro names with dots and dashes", () => {
    expect(buildWslAutostartTaskRun("Ubuntu-22.04", "dev", "/usr/local/bin/codecast")).toContain("-d Ubuntu-22.04");
  });

  it("rejects components that need quoting", () => {
    // The command passes through schtasks, cmd, and PowerShell parsing —
    // spaces or quote characters anywhere would need triple-layer escaping,
    // so the builder refuses instead.
    expect(buildWslAutostartTaskRun("Ubuntu 22.04", "dev", "/usr/local/bin/codecast")).toBeNull();
    expect(buildWslAutostartTaskRun("Ubuntu", "some user", "/usr/local/bin/codecast")).toBeNull();
    expect(buildWslAutostartTaskRun("Ubuntu", "dev", "/path with space/codecast")).toBeNull();
    expect(buildWslAutostartTaskRun("Ubuntu", 'a"b', "/usr/local/bin/codecast")).toBeNull();
    expect(buildWslAutostartTaskRun("", "dev", "/usr/local/bin/codecast")).toBeNull();
  });
});

describe("daemonSupportedOnPlatform", () => {
  it("supports the current (non-Windows) test platform", () => {
    expect(daemonSupportedOnPlatform()).toBe(process.platform !== "win32");
  });
});
