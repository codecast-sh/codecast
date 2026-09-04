/**
 * The extension ID the CLI opens pairing URLs against must be the ID Chrome
 * gives the extension. Chrome derives it from the manifest's public key, so
 * the constant is checked against the committed manifest with Chrome's rule,
 * and the rule itself against a value a scratch Chrome for Testing reported
 * through chrome.runtime.id (2026-09-01, Chrome for Testing 146).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BRIDGE_EXTENSION_ID, bridgePairingPage, bridgePairingUrl, extensionIdOfKey } from "./protocol.js";

const manifestPath = path.join(import.meta.dir, "../../../../browser-extension/manifest.json");

describe("BRIDGE_EXTENSION_ID", () => {
  test("is what Chrome derives from the manifest key", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { key?: string };
    expect(manifest.key).toBeTruthy();
    expect(extensionIdOfKey(manifest.key!)).toBe(BRIDGE_EXTENSION_ID);
  });

  test("the derivation matches chrome.runtime.id for a known key", () => {
    // The committed key, loaded unpacked in Chrome for Testing 146: the
    // service worker target came up as chrome-extension://dfimhlgg.../background.js.
    const key =
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw46Qcb9BYV9TSDQdsCiMwljPrj8xuWm/68v3WQ6St89FVeq4mEziHfpuokT+SxhCWh+4rq2eOD+jTFCgYHAMu5B6VRnaV3Ik9jugMYF8LHPwwKSOjnXGIKenlJDQ9VbA/cpSr9dPfhj0cd5pt3mElFEkTO/PS99ueOeq3pOX+xwUembbsaqZfyn7HtT4dpq8hivTN0+XbPl1pEsw0rZ6pe95neJi/JDl80F470U0VzsKNQIZCDbI08YHaYFBOtfkOmxiM3FJmZkLpiCBU2RwwWw95LsEOP/1aE1uF8ItC2KDlLtNQ3Rk0RNTU1BMLs3AXE59KCIShbr2LSLhKEaEBQIDAQAB";
    expect(extensionIdOfKey(key)).toBe("dfimhlggoaabdefnfhlpboehapdaakol");
  });

  test("an ID is 32 letters from a to p", () => {
    expect(BRIDGE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(extensionIdOfKey(Buffer.from("not a real key").toString("base64"))).toMatch(/^[a-p]{32}$/);
  });
});

describe("bridgePairingUrl", () => {
  test("carries token and port in the fragment of the options page", () => {
    const url = new URL(bridgePairingUrl({ token: "ab".repeat(32), port: 41729 }));
    expect(url.protocol).toBe("chrome-extension:");
    expect(url.host).toBe(BRIDGE_EXTENSION_ID);
    expect(url.pathname).toBe("/options.html");
    expect(url.search).toBe("");
    const frag = new URLSearchParams(url.hash.slice(1));
    expect(frag.get("token")).toBe("ab".repeat(32));
    expect(frag.get("port")).toBe("41729");
  });
});

describe("bridgePairingPage", () => {
  test("forwards to exactly the pairing URL, fragment included", () => {
    const url = bridgePairingUrl({ token: "cd".repeat(32), port: 41729 });
    const page = bridgePairingPage(url);
    expect(page).toContain(`location.replace(${JSON.stringify(url)})`);
    expect(page.match(/<script>/g)).toHaveLength(1);
  });

  test("a URL cannot break out of the script", () => {
    const page = bridgePairingPage("chrome-extension://x/options.html#t=</script><script>alert(1)");
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page).not.toContain("</script><script>alert");
  });
});
