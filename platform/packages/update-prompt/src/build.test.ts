import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpReleasePrompt, buildIdentity, readReleasePrompt, updatePromptVite } from "./build";

function releaseFile(body: unknown) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "release-prompt-")), "release-prompt.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

describe("release prompt", () => {
  it("bumps the generation and sets the card's line", () => {
    const file = releaseFile({ generation: 0, message: "" });
    expect(bumpReleasePrompt(file, "  Fixes the crash.  ")).toEqual({ generation: 1, message: "Fixes the crash." });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ generation: 1, message: "Fixes the crash." });
    expect(bumpReleasePrompt(file, "Again.").generation).toBe(2);
  });

  it("refuses a bump with nothing to say", () => {
    expect(() => bumpReleasePrompt(releaseFile({ generation: 0 }), " ")).toThrow();
  });

  it("reads a hand-edited file leniently", () => {
    expect(readReleasePrompt(releaseFile({ generation: "x" }))).toEqual({ generation: 0, message: "" });
  });
});

describe("updatePromptVite", () => {
  it("bakes the identity into define and emits the same object as version.json", () => {
    const file = releaseFile({ generation: 7, message: "New rooms." });
    const plugin = updatePromptVite({ releaseFile: file, define: "__APP_BUILD__", identity: (mode) => ({ mode }) });
    const { define } = plugin.config({}, { mode: "production" });
    const baked = JSON.parse(define.__APP_BUILD__!);
    expect(baked).toEqual({ mode: "production", promptGeneration: 7, promptMessage: "New rooms." });

    const emitted: { fileName: string; source: string }[] = [];
    plugin.generateBundle.call({ emitFile: (f) => { emitted.push(f); return f.fileName; } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toBe("version.json");
    expect(JSON.parse(emitted[0]!.source)).toEqual(baked);
  });

  it("lets the release prompt win over an identity field of the same name", () => {
    const file = releaseFile({ generation: 2, message: "" });
    expect(buildIdentity({ releaseFile: file, identity: () => ({ promptGeneration: 99 }) }, "x").promptGeneration).toBe(2);
  });
});
