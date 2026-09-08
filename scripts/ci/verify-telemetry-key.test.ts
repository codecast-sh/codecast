// The build gate that keeps a keyless bundle from shipping silently (ct-49565).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain node script, no types
import { verifyTelemetryKey } from "./verify-telemetry-key.mjs";

const KEY = "phc_Qfq3Fhk6pyxB8vkDoUVqSKvAgiVkqR3ARoAtwaYqE6Z";

let root: string;

function writeWebDist(contents: string) {
  mkdirSync(join(root, "packages/web/dist/assets"), { recursive: true });
  writeFileSync(join(root, "packages/web/dist/assets/index-abc123.js"), contents);
}

function writeCliBinary(contents: string) {
  mkdirSync(join(root, "packages/web/binaries"), { recursive: true });
  writeFileSync(join(root, "packages/web/binaries/codecast-darwin-arm64"), contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "telemetry-key-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("verifyTelemetryKey", () => {
  it("passes when the bundle carries the key", () => {
    writeWebDist(`posthog.init("${KEY}",{api_host:"https://us.i.posthog.com"})`);
    writeCliBinary("compiled bun binary, no telemetry");
    const { errors } = verifyTelemetryKey({ root, key: KEY });
    expect(errors).toEqual([]);
  });

  it("fails a bundle built without the key, which is the silent shipping case", () => {
    // What the minifier actually leaves behind: the whole init branch is gone.
    writeWebDist("var a=1;export{a};");
    const { errors } = verifyTelemetryKey({ root, key: KEY });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("web dist");
    expect(errors[0]).toContain("none of the 1 files");
  });

  it("fails when a PostHog key reached a CLI binary", () => {
    writeWebDist(`posthog.init("${KEY}")`);
    writeCliBinary(`fetch("https://us.i.posthog.com",{body:'{"api_key":"${KEY}"}'})`);
    const { errors } = verifyTelemetryKey({ root, key: KEY });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("CLI binaries");
  });

  it("skips a target nobody built, and fails it under --require", () => {
    expect(verifyTelemetryKey({ root, key: KEY }).errors).toEqual([]);
    expect(verifyTelemetryKey({ root, key: KEY, requireArtifacts: true }).errors.length).toBe(2);
  });

  it("fails a release with no key configured rather than checking nothing", () => {
    writeWebDist(`posthog.init("${KEY}")`);
    const relaxed = verifyTelemetryKey({ root, key: "" });
    expect(relaxed.errors).toEqual([]);
    expect(relaxed.notes.join("\n")).toContain("no key to look for");

    const strict = verifyTelemetryKey({ root, key: "", requireArtifacts: true });
    expect(strict.errors.some((e: string) => e.includes("no key to look for"))).toBe(true);
  });
});
