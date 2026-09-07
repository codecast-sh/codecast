/**
 * `cast guide` serves the catalog from the binary, with the binary named.
 *
 * The two properties worth pinning: the text an agent reads is the SAME text
 * `cast install` writes (a guide that paraphrased the sections would be a
 * second copy to keep in step), and every guide names the cast that printed it
 * (an agent reading flags has no other way to know which binary answers them).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { guideTopics, snippetBySlug } from "@codecast/shared/contracts";
import { DAEMON_BUILD_ID } from "./daemonBuildId.js";
import { getVersion } from "./update.js";
import { guideBody, guideHeader, guidePayload, unknownTopicMessage } from "./guide.js";

const cliEntry = path.join(import.meta.dir, "index.ts");

/** A scratch HOME so a guide run cannot read or write the real machine's
 *  config, and so the update check has a fresh state file to find. */
function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-guide-"));
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codecast", "update-state.json"),
    JSON.stringify({ lastCheck: new Date().toISOString() }),
  );
  return home;
}

function runGuide(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = scratchHome();
  try {
    const proc = spawnSync(process.execPath, [cliEntry, "guide", ...args], {
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("cast guide", () => {
  test("every topic's body is the catalog section, without the installer's markers", () => {
    for (const topic of guideTopics()) {
      const section = topic.section!;
      // Derived from the catalog here rather than through guideBody, so the
      // assertion is a real comparison and not the function agreeing with
      // itself.
      const expected = section.body.split(section.spec.endMarker).join("").trim();
      expect(`${topic.slug}: ${guideBody(topic)}`).toBe(`${topic.slug}: ${expected}`);
      expect(guideBody(topic)).toContain(section.spec.headings[0]);
    }
  });

  test("the header names the binary that printed it", () => {
    const header = guideHeader("browser");
    expect(header).toContain(`cast v${getVersion()}`);
    expect(header).toContain(DAEMON_BUILD_ID);
  });

  test("the json payload carries the version, the build id, and the body", () => {
    const payload = guidePayload(snippetBySlug("tasks")!);
    expect(payload).toMatchObject({
      topic: "tasks",
      version: getVersion(),
      build_id: DAEMON_BUILD_ID,
    });
    expect(payload.body).toContain("## Tasks & Plans");
  });

  test("an unknown topic names every topic there is", () => {
    const message = unknownTopicMessage("nope");
    for (const topic of guideTopics()) expect(message).toContain(topic.slug);
  });

  test("`cast guide <topic>` prints the version header and the whole body", () => {
    const run = runGuide(["browser"]);
    expect(run.status).toBe(0);
    const [header] = run.stdout.split("\n");
    expect(header).toBe(guideHeader("browser"));
    expect(run.stdout).toContain(guideBody(snippetBySlug("browser")!));
  }, 60_000);

  test("`cast guide --list` names every topic and the binary serving them", () => {
    const run = runGuide(["--list"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`cast v${getVersion()}`);
    expect(run.stdout).toContain(DAEMON_BUILD_ID);
    for (const topic of guideTopics()) expect(run.stdout).toContain(topic.slug);
  }, 60_000);

  test("an alias resolves to its topic, and an unknown one exits non-zero", () => {
    // `work` is the tasks snippet — the catalog's historical mapping, which the
    // guide inherits for free by resolving through snippetBySlug.
    const alias = runGuide(["work"]);
    expect(alias.status).toBe(0);
    expect(alias.stdout).toContain("## Tasks & Plans");

    const unknown = runGuide(["nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown guide topic: nope");
  }, 60_000);
});
