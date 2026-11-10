import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engineVersion } from "./engine.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";

// Every `cast browser …` asks the engine's version while it registers its
// commands; the answer is kept against the binary so the engine is spawned
// once per installed copy, not once per invocation.
describe("engineVersion", () => {
  isolateCodecastDirEachTest();
  let dir: string;
  let bin: string;
  let calls: string;
  const prev = process.env.CAST_BROWSER_ENGINE;
  const install = (version: string) => {
    fs.writeFileSync(bin, `#!/bin/bash\necho x >> "${calls}"\necho "agent-browser ${version}"\n`, { mode: 0o755 });
  };
  const spawns = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8").trim().split("\n").length : 0);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-engine-version-"));
    bin = path.join(dir, "agent-browser");
    calls = path.join(dir, "calls");
    process.env.CAST_BROWSER_ENGINE = bin;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CAST_BROWSER_ENGINE;
    else process.env.CAST_BROWSER_ENGINE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the engine is asked once, and again only when its binary changes", () => {
    install("1.2.3");
    expect(engineVersion()).toBe("1.2.3");
    expect(engineVersion()).toBe("1.2.3");
    expect(spawns()).toBe(1);
    install("1.10.0-longer");
    expect(engineVersion()).toBe("1.10.0-longer");
    expect(spawns()).toBe(2);
  });

  test("an engine that will not say its version is asked again next time", () => {
    fs.writeFileSync(bin, `#!/bin/bash\necho x >> "${calls}"\nexit 1\n`, { mode: 0o755 });
    expect(engineVersion()).toBeNull();
    expect(engineVersion()).toBeNull();
    expect(spawns()).toBe(2);
  });
});
