import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { computeDaemonBuildId, scanSpecifiers, codeForSpecifiers } from "./daemonBuildIdCompute.js";

// A miniature repo shaped like the real one: the walker only knows how to
// start at packages/cli/src/daemon.ts, so the fixture provides that path.
let root: string;

const write = (rel: string, body: string) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "buildid-"));
  write("packages/cli/package.json", JSON.stringify({ version: "1.0.0", dependencies: { ws: "8.18.0" } }));
  write(
    "packages/cli/src/daemon.ts",
    `import { a } from "./a.js";\nimport "./bare.js";\nconst m = await import("./dyn.js");\nimport ws from "ws";\nexport { a, m, ws };\n`,
  );
  write("packages/cli/src/a.ts", `export { deep } from "./nested/deep.js";\nexport const a = 1;\n`);
  write("packages/cli/src/nested/deep.ts", `export const deep = 1;\n`);
  write("packages/cli/src/bare.ts", `export {};\n`);
  write("packages/cli/src/dyn.ts", `export const dyn = 1;\n`);
  write("packages/cli/src/unrelated.ts", `export const unrelated = 1;\n`);
  write("packages/cli/src/daemonBuildId.ts", `export const DAEMON_BUILD_ID = "aaaaaaaaaaaa";\n`);
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("computeDaemonBuildId", () => {
  test("is deterministic across runs", () => {
    expect(computeDaemonBuildId(root).id).toBe(computeDaemonBuildId(root).id);
  });

  test("reaches transitive relative imports, bare imports and dynamic imports", () => {
    const { files, external } = computeDaemonBuildId(root);
    expect(files).toContain("packages/cli/src/a.ts");
    expect(files).toContain("packages/cli/src/nested/deep.ts");
    expect(files).toContain("packages/cli/src/bare.ts");
    expect(files).toContain("packages/cli/src/dyn.ts");
    expect(external).toContain("ws");
  });

  test("editing a transitively imported file changes the id", () => {
    const before = computeDaemonBuildId(root).id;
    write("packages/cli/src/nested/deep.ts", `export const deep = 2;\n`);
    expect(computeDaemonBuildId(root).id).not.toBe(before);
    write("packages/cli/src/nested/deep.ts", `export const deep = 1;\n`);
    expect(computeDaemonBuildId(root).id).toBe(before);
  });

  test("editing a file nothing imports does not change the id", () => {
    const before = computeDaemonBuildId(root).id;
    write("packages/cli/src/unrelated.ts", `export const unrelated = 99;\n`);
    expect(computeDaemonBuildId(root).id).toBe(before);
  });

  test("the stamp file itself is excluded, so stamping is not a fixed point chase", () => {
    write("packages/cli/src/daemon.ts", `import "./a.js";\nimport "./daemonBuildId.js";\nexport {};\n`);
    const before = computeDaemonBuildId(root).id;
    expect(computeDaemonBuildId(root).files).not.toContain("packages/cli/src/daemonBuildId.ts");
    write("packages/cli/src/daemonBuildId.ts", `export const DAEMON_BUILD_ID = "bbbbbbbbbbbb";\n`);
    expect(computeDaemonBuildId(root).id).toBe(before);
  });

  test("a dependency range moves the id, the version does not", () => {
    const before = computeDaemonBuildId(root).id;
    write("packages/cli/package.json", JSON.stringify({ version: "9.9.9", dependencies: { ws: "8.18.0" } }));
    expect(computeDaemonBuildId(root).id).toBe(before);
    write("packages/cli/package.json", JSON.stringify({ version: "9.9.9", dependencies: { ws: "9.0.0" } }));
    expect(computeDaemonBuildId(root).id).not.toBe(before);
  });

  test("an unresolvable relative specifier is recorded, not thrown", () => {
    write("packages/cli/src/daemon.ts", `import "./missing.js";\nexport {};\n`);
    const r = computeDaemonBuildId(root);
    expect(r.external).toContain("./missing.js");
    expect(r.id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("scanSpecifiers", () => {
  test("takes static, dynamic and bare import specifiers", () => {
    const specs = scanSpecifiers(
      `import a from "./a.js";\nexport * from "./b.js";\nimport "./c.js";\nawait import("./d.js");\n`,
    );
    expect(specs.sort()).toEqual(["./a.js", "./b.js", "./c.js", "./d.js"]);
  });

  test("ignores specifiers named inside comments", () => {
    expect(scanSpecifiers(`// from "./ghost.js"\n/* import "./ghost2.js" */\nimport "./real.js";\n`)).toEqual([
      "./real.js",
    ]);
  });

  test("ignores a specifier shaped string that is data, not an import", () => {
    const src = `const script = 'ObjC.import("Foundation");';\nconst hdr = \`{"id","from","to"}\`;\nimport "./real.js";\n`;
    expect(scanSpecifiers(src)).toEqual(["./real.js"]);
  });

  test("keeps a // inside a string out of the comment stripper", () => {
    expect(codeForSpecifiers(`const u = "https://x.example/y"; import "./real.js";`)).toContain(`import "./real.js"`);
  });
});
