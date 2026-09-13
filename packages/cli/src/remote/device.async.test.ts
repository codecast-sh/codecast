import { expect, spyOn, test } from "bun:test";
import * as proc from "../proc.js";
import { resetHostnameForTests, stableHostname, stableHostnameAsync } from "./device.js";

test.skipIf(process.platform !== "darwin")("asynchronous hostname discovery yields, falls back to Bonjour and warms the sync cache", async () => {
  resetHostnameForTests();
  const sync = spyOn(proc, "execFileSync").mockImplementation(() => { throw new Error("sync hostname lookup"); });
  const commands = spyOn(proc, "execFileAsync").mockImplementation((async (_command: string, args: string[]) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (args[1] === "HostName") throw new Error("HostName not set");
    return { stdout: "test-mac\n", stderr: "" };
  }) as any);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    expect(await stableHostnameAsync()).toBe("test-mac");
    expect(stableHostname()).toBe("test-mac");
    expect(ticks).toBeGreaterThan(0);
    expect(sync).not.toHaveBeenCalled();
    expect(commands.mock.calls.map(call => call[1]?.[1])).toEqual(["HostName", "LocalHostName"]);
  } finally {
    clearInterval(timer);
    sync.mockRestore();
    commands.mockRestore();
    resetHostnameForTests();
  }
});
