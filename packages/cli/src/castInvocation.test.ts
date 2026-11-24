import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCastInvocation } from "./castInvocation.js";

test("a compiled binary runs itself again through its own path, never `cast` off PATH (ct-98253)", () => {
  const binary = process.execPath;
  expect(resolveCastInvocation(["bun", "/$bunfs/root/codecast", "flow", "run"], binary)).toEqual({ cmd: binary, prefixArgs: [] });
  expect(resolveCastInvocation(["bun", "B:/~BUN/root/codecast.exe", "_daemon"], binary)).toEqual({ cmd: binary, prefixArgs: [] });
});

test("a compiled binary whose file an upgrade removed falls back to `cast` off PATH", () => {
  expect(resolveCastInvocation(["bun", "/$bunfs/root/codecast", "_daemon"], "/opt/homebrew/Cellar/codecast/0.0.1/bin/cast")).toEqual({ cmd: "cast", prefixArgs: [] });
});

test("from source, bun runs the entry beside this module", () => {
  const entry = path.join(import.meta.dir, "main.ts");
  expect(resolveCastInvocation(["/opt/bun", entry, "flow"], "/opt/bun")).toEqual({ cmd: "/opt/bun", prefixArgs: [entry] });
});

test("compiled and started with ssh's PATH (/usr/bin:/bin), a self-spawn reaches the binary (ct-98253)", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-invocation-")));
  try {
    const probe = path.join(dir, "probe.ts");
    fs.writeFileSync(probe, [
      `import { spawnSync } from "node:child_process";`,
      `import { resolveCastInvocation } from ${JSON.stringify(path.join(import.meta.dir, "castInvocation.ts"))};`,
      `if (process.argv[2] === "child") { console.log("child ran"); process.exit(0); }`,
      `const { cmd, prefixArgs } = resolveCastInvocation();`,
      `const r = spawnSync(cmd, [...prefixArgs, "child"], { encoding: "utf-8" });`,
      `console.log(JSON.stringify({ cmd, status: r.status, out: r.stdout, error: r.error?.message }));`,
    ].join("\n"));
    const bin = path.join(dir, "probe");
    const built = spawnSync(process.execPath, ["build", "--compile", probe, "--outfile", bin], { encoding: "utf-8" });
    expect(built.status, built.stderr).toBe(0);
    const ran = spawnSync(bin, [], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin", HOME: dir } });
    expect(JSON.parse(ran.stdout)).toEqual({ cmd: bin, status: 0, out: "child ran\n" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
