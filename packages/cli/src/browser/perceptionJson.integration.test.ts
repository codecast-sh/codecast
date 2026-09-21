import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function command(driver: "direct" | "engine", args: string[], scenario = "ok") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-perception-json-"));
  dirs.push(dir);
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(720, 16);
  png.writeUInt32BE(480, 20);
  const image = path.join(dir, "fixture.png");
  fs.writeFileSync(image, png);
  const engine = path.join(dir, "engine");
  fs.writeFileSync(engine, `#!${process.execPath}
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
const reply = (data) => console.log(JSON.stringify({ success: true, data }));
if (args[0] === "snapshot") {
  if (process.env.FIXTURE_SCENARIO === "failure") {
    console.log(JSON.stringify({success: false, error: "snapshot unavailable"}));
    process.exit(1);
  }
  if (process.env.FIXTURE_SCENARIO === "stall" && !fs.existsSync(process.env.FIXTURE_RETRIED)) {
    fs.writeFileSync(process.env.FIXTURE_RETRIED, "1");
    console.error("tabs.list did not answer within 20000ms");
    process.exit(1);
  }
  reply({ origin: "https://fixture.test/", lifecycle: { reused: true }, refs: { e1: {role: "button", name: "Save"}, e2: {role: "button", name: "Save"} }, snapshot: '- button "Save" [ref=e1]\\n- button "Save" [ref=e2]' });
} else if (args[0] === "screenshot") {
  const file = args.find((a) => a.endsWith(".png"));
  fs.copyFileSync(process.env.FIXTURE_IMAGE, file);
  reply({ path: file, annotations: [{ number: 1, ref: "e1", role: "button", name: "Save" }] });
} else if (args[0] === "eval") {
  if (process.env.FIXTURE_SCENARIO === "scale-failure") process.exit(1);
  reply({ result: 2 });
} else throw new Error("unexpected engine call: " + args.join(" "));
`, { mode: 0o700 });
  const file = (name: string) => JSON.stringify(path.join(import.meta.dir, name));
  const child = Bun.spawn([process.execPath, "-e", `
    import { spyOn } from "bun:test";
    import { Command } from "commander";
    import * as real from ${file("bridge/real.ts")};
    import * as pinned from ${file("pinnedTab.ts")};
    import * as engine from ${file("engine.ts")};
    import * as images from ${file("../imageCommand.ts")};
    import { readFileSync, writeFileSync } from "node:fs";
    const page = { sessionId: "fixture", targetId: "fixture", conn: { send: async (method, params = {}) => {
      if (method === "Runtime.evaluate") {
        if (params.expression === "devicePixelRatio") return {result: {value: 2}};
        if (params.expression.includes("contenteditable")) return {result: {value: "[]"}};
        if (params.expression.startsWith("delete ")) return {};
        return {result: {value: JSON.stringify(["https://fixture.test/", "Fixture"])}};
      }
      if (method === "Page.getFrameTree") return {frameTree: {frame: {id: "main"}}};
      if (method === "Accessibility.getFullAXTree") return {nodes: [
        {nodeId: "1", role: {value: "RootWebArea"}, name: {value: "Fixture"}, childIds: ["2"]},
        {nodeId: "2", parentId: "1", role: {value: "button"}, name: {value: "Save"}, backendDOMNodeId: 2},
      ]};
      if (method === "Page.captureScreenshot") return {data: readFileSync(process.env.FIXTURE_IMAGE).toString("base64")};
      throw new Error("unexpected CDP method: " + method);
    }}};
    spyOn(real, "withRealPage").mockImplementation(async (_opts, fn) => fn(page, {}, page.conn));
    spyOn(real, "requireRealBridge").mockResolvedValue({});
    spyOn(real, "engineBrowserFor").mockImplementation(async (session) => ({session, cdp: "ws://127.0.0.1:1/fixture"}));
    spyOn(pinned, "ensurePinnedTab").mockResolvedValue(undefined);
    spyOn(engine, "engineFitness").mockReturnValue({ok: true});
    spyOn(images, "uploadOne").mockResolvedValue({url: "https://images.fixture.test/shot.png", markdown: "do not print this"});
    const { registerBrowserCommand } = await import(${file("cli.ts")});
    const program = new Command();
    registerBrowserCommand(program, { detectCurrentSessionId: () => "fixture" });
    const { recallSnapshotRef } = await import(${file("refMemory.ts")});
    process.on("exit", () => writeFileSync(process.env.FIXTURE_MEMORY, JSON.stringify(recallSnapshotRef(engine.realSessionKey(engine.engineSession(() => "fixture")), "e2"))));
    await program.parseAsync(["bun", "cast", "browser", ...${JSON.stringify(args)}]);
  `], {
    stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      CODECAST_DIR: path.join(dir, "state"),
      CAST_BROWSER_LEGACY: driver === "direct" ? "1" : "0",
      CAST_BROWSER_ENGINE: engine,
      FIXTURE_IMAGE: image,
      FIXTURE_CALLS: path.join(dir, "calls.jsonl"),
      FIXTURE_MEMORY: path.join(dir, "memory.json"),
      FIXTURE_RETRIED: path.join(dir, "retried"),
      FIXTURE_SCENARIO: scenario,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const callsFile = path.join(dir, "calls.jsonl");
  const calls: string[][] = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { dir, stdout, stderr, code, calls };
}

for (const driver of ["direct", "engine"] as const) {
  describe(`${driver} perception command JSON`, () => {
    test("snapshot produces one normalized object through the registered command", async () => {
      const result = await command(driver, ["snapshot", "--json"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.url).toBe("https://fixture.test/");
      expect(json.refs).toContainEqual({ ref: "e2", role: "button", name: "Save" });
      expect(json.text).toContain("Save");
      expect(json.truncated).toBe(false);
      expect(json.lifecycle).toBeUndefined();
      if (driver === "engine") {
        expect(json.text).toContain("Save (2nd)");
        expect(JSON.parse(fs.readFileSync(path.join(result.dir, "memory.json"), "utf8"))).toEqual({ role: "button", name: "Save", nth: 2 });
      }
    }, 15000);

    test("shared JSON shots add the URL without printing markdown", async () => {
      const result = await command(driver, ["shot", "--json", "--share"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).url).toBe("https://images.fixture.test/shot.png");
      expect(result.stdout).not.toContain("do not print this");
    }, 15000);

    test("shot prints file metadata without an inline marker or encoded pixels", async () => {
      const result = await command(driver, ["shot", "--json", ...(driver === "engine" ? ["--annotate"] : [])]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json).toMatchObject({ width: 720, height: 480, scale: 2, bytes: 24 });
      expect(path.isAbsolute(json.path)).toBe(true);
      expect(fs.readFileSync(json.path).length).toBe(24);
      expect(fs.statSync(json.path).mode & 0o777).toBe(0o600);
      expect(result.stdout).not.toContain("base64");
      expect(result.stdout).not.toContain("data:image");
      if (driver === "engine") {
        expect(json.annotations).toEqual([{ number: 1, ref: "e1", role: "button", name: "Save" }]);
        expect(result.calls.filter((call) => call[0] === "screenshot")).toHaveLength(1);
      }
    }, 15000);
  });
}

test("an unavailable scale is null while the screenshot remains usable", async () => {
  const result = await command("engine", ["shot", "--json"], "scale-failure");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ width: 720, height: 480, scale: null });
}, 15000);

test("a failed snapshot does not become a successful empty object", async () => {
  const result = await command("engine", ["snapshot", "--json", "--no-capture"], "failure");
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("snapshot unavailable");
});

test("direct JSON shot rejects a viewport row", async () => {
  const result = await command("direct", ["shot", "--json", "--viewports", "desktop,mobile"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--json does not combine with --viewports");
});

test("JSON snapshot keeps the existing retry for a stalled bridge", async () => {
  const result = await command("engine", ["snapshot", "--json", "--no-capture"], "stall");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).refs).toHaveLength(2);
  expect(result.calls.filter((call) => call[0] === "snapshot")).toHaveLength(2);
}, 15000);
