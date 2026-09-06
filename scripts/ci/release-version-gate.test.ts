import { describe, expect, test } from "bun:test";

import { checkVersionAhead } from "./release-version-gate.ts";

const gate = (published: string, next: string, allowEqual = false) =>
  checkVersionAhead({ channel: "CLI", published, next, allowEqual });

describe("checkVersionAhead", () => {
  test("passes a version ahead of the published one", () => {
    expect(gate("1.2.3", "1.2.4").ok).toBe(true);
    expect(gate("1.2.9", "1.2.10").ok).toBe(true);
    expect(gate("1.99.99", "2.0.0").ok).toBe(true);
  });

  test("refuses a version behind the published one", () => {
    const verdict = gate("1.2.9", "1.2.4");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("behind the published 1.2.9");
    expect(verdict.ok === false && verdict.reason).toContain("Pull main");
  });

  test("refuses to republish the published version unless asked to", () => {
    expect(gate("1.2.4", "1.2.4").ok).toBe(false);
    expect(gate("1.2.4", "1.2.4", true)).toEqual({
      ok: true,
      note: "CLI 1.2.4 republishes the published version",
    });
  });

  test("still refuses a behind version when equal is allowed", () => {
    expect(gate("1.2.9", "1.2.4", true).ok).toBe(false);
  });

  test("refuses a version it cannot read rather than comparing garbage", () => {
    // A missing latest.json makes `jq -r .version` print "null"; segment
    // comparison would read that as 0 and wave every release through.
    for (const published of ["null", "", "1.2", "1.x.0", "v1.2.3", "1.2.3-rc.1"]) {
      const verdict = gate(published, "1.2.4");
      expect(verdict.ok, `published ${JSON.stringify(published)}`).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain("unreadable published version");
    }
    const badNext = gate("1.2.3", "1.2");
    expect(badNext.ok === false && badNext.reason).toContain("unreadable next version");
  });

  test("names the channel it refused", () => {
    const verdict = checkVersionAhead({ channel: "Desktop", published: "1.1.104", next: "1.1.90" });
    expect(verdict.ok === false && verdict.reason.startsWith("Desktop 1.1.90")).toBe(true);
  });
});

describe("the release scripts call the gate", () => {
  const read = async (path: string) =>
    await Bun.file(new URL(path, import.meta.url)).text();

  test("CLI deploy.sh gates on the R2 latest.json version before bumping", async () => {
    const script = await read("../../packages/cli/scripts/deploy.sh");
    const gateLine = script.indexOf("release-version-gate.ts");
    const bumpLine = script.indexOf("jq --arg v \"$VERSION\" '.version = $v' package.json");
    expect(gateLine).toBeGreaterThan(-1);
    expect(bumpLine).toBeGreaterThan(gateLine);
    expect(script).toContain('aws s3 cp "s3://$R2_BUCKET/latest.json"');
    expect(script).toContain("jq -r '.version' /tmp/codecast-published-latest.json");
    expect(script).toContain("--channel \"CLI\"");
    expect(script).toContain("--allow-equal");
  });

  test("desktop release.sh gates on the R2 latest-mac.yml version before bumping", async () => {
    const script = await read("../../packages/electron/scripts/release.sh");
    const gateLine = script.indexOf("release-version-gate.ts");
    const bumpLine = script.indexOf("jq --arg v \"$NEW_VERSION\" '.version = $v' package.json");
    expect(gateLine).toBeGreaterThan(-1);
    expect(bumpLine).toBeGreaterThan(gateLine);
    expect(script).toContain('aws s3 cp "s3://$R2_BUCKET/desktop/latest-mac.yml"');
    expect(script).toContain('--channel "Desktop"');
    // A desktop rerun rebuilds and reuploads, so republishing a version is
    // never the recovery path it is for the CLI.
    expect(script).not.toContain("--allow-equal");
  });
});
