import { describe, expect, test } from "bun:test";
import { macDaemonScript } from "./provisionMac.js";

describe("macDaemonScript", () => {
  test("marks the box as a remote device in the launchd environment and on disk", () => {
    const s = macDaemonScript({ user: "codecast", homeDir: "/Users/codecast" });
    expect(s).toContain("<key>CODECAST_REMOTE_DEVICE</key><string>1</string>");
    // The marker precedes the plist so a daemon any other launcher starts there is remote too.
    expect(s).toContain(': > "$HOME/.codecast/remote-device"');
    expect(s.indexOf("remote-device")).toBeLessThan(s.indexOf("/Library/LaunchDaemons/"));
  });
});
