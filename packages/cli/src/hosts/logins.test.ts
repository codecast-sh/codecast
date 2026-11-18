import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { readHosts, writeHosts, type CloudHost } from "../browser/cloudHost";
import { registerHostLoginsCommand } from "./logins";

let dir: string, prev: string | undefined;
const legacy: CloudHost = { id: "i-old", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.1.1.1" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-host-logins-"));
  prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  writeHosts([legacy]);
});

afterEach(() => {
  if (prev === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function cast(...args: string[]): Promise<string[]> {
  const out: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  try {
    const program = new Command();
    registerHostLoginsCommand(program.command("hosts"));
    await program.parseAsync(["hosts", "logins", ...args], { from: "user" });
  } finally {
    log.mockRestore();
  }
  return out;
}

describe("cast hosts logins (#99)", () => {
  test("shows, narrows, widens and resets one host's setting in the registry", async () => {
    expect((await cast("i-old"))[0]).toBe("logins to i-old: all");
    expect(readHosts()[0].logins).toBeUndefined();
    await cast("i-old", "--off", "aws,kube");
    expect(readHosts()[0].logins).toEqual({ off: ["aws", "kube"] });
    await cast("i-old", "--on", "aws");
    expect(readHosts()[0].logins).toEqual({ off: ["kube"] });
    expect((await cast("i-old", "--only", "gh,codex"))[0]).toContain("logins to i-old: only gh, codex");
    expect(readHosts()[0].logins).toEqual({ only: ["gh", "codex"] });
    await cast("i-old", "--all");
    expect(readHosts()[0].logins).toEqual({ off: [] });
  });
});
