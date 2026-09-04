import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { computeDaemonBuildId, findRepoRoot, scanSpecifiers, codeForSpecifiers } from "./daemonBuildIdCompute.js";

// A miniature repo shaped like the real one: the walker only knows how to
// start at packages/cli/src/daemon.ts, so the fixture provides that path.
let root: string;

const write = (rel: string, body: string) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// The fixture entry, kept as a constant because two tests rewrite daemon.ts and
// a later test needs the full set of specifiers back.
const ENTRY_SRC =
  `import { a } from "./a.js";\nimport "./bare.js";\nconst m = await import("./dyn.js");\nimport ws from "ws";\n` +
  `import pkg from "../package.json";\nimport { c } from "@codecast/shared/contracts";\n` +
  `import { k } from "@platform/cli-kit";\nimport { ghost } from "@platform/nothing-here";\n` +
  `export { a, m, ws, pkg, c, k, ghost };\n`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "buildid-"));
  write("packages/cli/package.json", JSON.stringify({ version: "1.0.0", dependencies: { ws: "8.18.0" } }));
  write("packages/cli/src/daemon.ts", ENTRY_SRC);
  write("packages/shared/contracts.ts", `export const c = 1;\n`);
  write("platform/packages/cli-kit/src/a.ts", `export const k = 1;\n`);
  write("platform/packages/cli-kit/src/b.ts", `export const k2 = 2;\n`);
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

  // These two branches resolve a third of the real closure, and both fail
  // silently: an unresolvable specifier becomes an external string instead of
  // throwing. If a root path ever moves, those files leave the hashed set and
  // the veto starts suppressing restarts that were needed.
  test("reaches @codecast/shared and every source file of a @platform package", () => {
    const { files, external } = computeDaemonBuildId(root);
    expect(files).toContain("packages/shared/contracts.ts");
    expect(files).toContain("platform/packages/cli-kit/src/a.ts");
    expect(files).toContain("platform/packages/cli-kit/src/b.ts");
    expect(external).not.toContain("@codecast/shared/contracts");
    expect(external).not.toContain("@platform/cli-kit");
  });

  test("an unknown @platform package is recorded, not thrown", () => {
    expect(computeDaemonBuildId(root).external).toContain("@platform/nothing-here");
  });

  // The blocker this test exists for: package.json resolves as a real file, so
  // before the .ts only rule it joined the closure and its version string went
  // into the id. Every release bumps that version, which would re-stamp the id
  // and bounce a daemon holding hundreds of panes for a release that changed no
  // daemon code.
  test("importing package.json does not put the version in the id", () => {
    const { files, external } = computeDaemonBuildId(root);
    expect(files).not.toContain("packages/cli/package.json");
    expect(external).toContain("../package.json");
    const before = computeDaemonBuildId(root).id;
    write("packages/cli/package.json", JSON.stringify({ version: "9.9.9", dependencies: { ws: "8.18.0" } }));
    expect(computeDaemonBuildId(root).id).toBe(before);
    write("packages/cli/package.json", JSON.stringify({ version: "1.0.0", dependencies: { ws: "8.18.0" } }));
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
    write("packages/cli/src/daemon.ts", ENTRY_SRC); // the previous test rewrote it
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

// The scanner reads a whole file as a small state machine, and it does not know
// what a regex literal is. A regex holding a quote character (`/["']/`) opens a
// phantom string in it, and every specifier after that point in the file can
// disappear. Nothing in the closure does that today, and the damage would be
// silent if something did: a dropped member means the id stops moving when that
// file changes, and a veto then suppresses a restart that was needed.
//
// So this walks the real closure and checks the scanner against a much dumber
// reader that only trusts a line whose first token is import or export.
describe("the scanner reads the real closure without losing specifiers", () => {
  test("every line anchored import in every hashed file is found", () => {
    const repoRoot = findRepoRoot();
    const { files } = computeDaemonBuildId(repoRoot);
    expect(files.length).toBeGreaterThan(100);

    const anchored = (src: string): string[] => {
      const out = new Set<string>();
      for (const line of src.split("\n")) {
        const m =
          line.match(/^(?:import|export)\b[^"']*\bfrom\s*["']([^"']+)["']/) ??
          line.match(/^import\s*["']([^"']+)["']/);
        if (m) out.add(m[1]);
      }
      return [...out];
    };

    const missed: string[] = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      const seen = new Set(scanSpecifiers(src));
      for (const spec of anchored(src)) if (!seen.has(spec)) missed.push(`${rel}: ${spec}`);
    }
    expect(missed).toEqual([]);
  }, 60_000);
});
