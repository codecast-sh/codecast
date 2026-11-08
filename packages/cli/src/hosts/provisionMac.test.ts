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

  test("attributes the LaunchDaemon to the desktop app, not the signing certificate's holder", () => {
    // The plist runs the signed cast binary directly; without this key macOS
    // announces it as "Software from <certificate holder> can run in the background".
    const s = macDaemonScript({ user: "codecast", homeDir: "/Users/codecast" });
    expect(s).toContain("<key>AssociatedBundleIdentifiers</key><array><string>sh.codecast.desktop</string></array>");
  });
});
