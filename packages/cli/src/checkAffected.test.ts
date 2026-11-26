/**
 * Which projects a tree's changes reach (checkAffected.ts): program lists
 * pooled across checkouts, matched by file and folder, and the bare ask.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import { buildInfoPath, watchDir } from "./check.js";
import { bunFileDepSource, changedFiles, programFiles, projectsForAsk, projectsTouching } from "./checkAffected.js";

describe("projectsTouching", () => {
  let iso: IsolatedCodecastDir;
  beforeEach(() => { iso = isolateCodecastDir(); });
  afterEach(() => iso.restore());

  test("picks the projects whose program holds a changed file, and a project above a file no program has seen", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-")));
    try {
      const projects = [
        { name: "web", tsconfig: "packages/web/tsconfig.json" },
        { name: "cli", tsconfig: "packages/cli/tsconfig.json" },
        { name: "convex", tsconfig: "packages/convex/tsconfig.json" },
      ];
      const info = (name: string, files: string[]) => {
        const dir = watchDir(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(root, f))) }));
      };
      info("web", ["packages/web/app.tsx", "packages/shared/x.ts"]);
      info("cli", ["packages/cli/src/a.ts"]);
      info("convex", ["packages/convex/f.ts", "packages/shared/x.ts"]);
      const names = (changed: string[]) => projectsTouching(root, projects, changed).map((p) => p.name);
      expect(names(["packages/shared/x.ts"])).toEqual(["web", "convex"]);
      expect(names(["packages/cli/src/new.ts"])).toEqual(["cli"]);
      expect(names(["README.md", "docs/a.md"])).toEqual([]);
      expect(names(["packages/web/tsconfig.json"])).toEqual(["web"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("in a checkout no program has built yet, reads each program's files from another checkout of the repository", () => {
    // A line run verifies in a worktree made for it: asked by folder alone, a
    // backend file mobile imports would not count for mobile.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-wt-")));
    try {
      const main = path.join(tmp, "main");
      const run = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" });
      fs.mkdirSync(main);
      run(main, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(main, "a.txt"), "a\n");
      run(main, "add", "a.txt");
      run(main, "commit", "-qm", "base");
      const wt = path.join(tmp, "line-ct-1");
      run(main, "worktree", "add", "-q", "-b", "line", wt);
      const projects = [
        { name: "backend", tsconfig: "server/backend/tsconfig.json" },
        { name: "mobile", tsconfig: "server/mobile/tsconfig.json" },
      ];
      const info = (name: string, files: string[]) => {
        const dir = watchDir(main, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(main, f))) }));
      };
      info("backend", ["server/backend/src/needs.ts"]);
      info("mobile", ["server/mobile/app.tsx", "server/backend/src/needs.ts"]);
      expect(projectsTouching(wt, projects, ["server/backend/src/needs.ts"]).map((p) => p.name)).toEqual(["backend", "mobile"]);
      // A new file in a folder mobile already imports from counts for mobile too: the next import of it needs no new list.
      expect(projectsTouching(wt, projects, ["server/backend/src/other.ts"]).map((p) => p.name)).toEqual(["backend", "mobile"]);
      expect(projectsTouching(wt, projects, ["server/backend/scripts/tool.ts"]).map((p) => p.name)).toEqual(["backend"]);
      // The lists are pooled: this tree's own, newer and without the import, does not hide the main checkout's.
      const own = watchDir(wt, "mobile");
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(buildInfoPath(own), JSON.stringify({ fileNames: [path.relative(own, path.join(wt, "server/mobile/app.tsx"))] }));
      expect(programFiles(wt, projects[1]!)).toEqual(new Set(["server/mobile/app.tsx", "server/backend/src/needs.ts"]));
      expect(projectsTouching(wt, projects, ["server/backend/src/needs.ts"]).map((p) => p.name)).toEqual(["backend", "mobile"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a resolution file reaches every project in or below its folder; a program never built anywhere counts for any code change", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-res-")));
    try {
      const projects = [
        { name: "web", tsconfig: "packages/web/tsconfig.json" },
        { name: "sim", tsconfig: "packages/web/store/sim/tsconfig.json" },
        { name: "cli", tsconfig: "packages/cli/tsconfig.typecheck.json" },
      ];
      const info = (name: string, files: string[]) => {
        const dir = watchDir(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(root, f))) }));
      };
      // tsc on a case-insensitive disk writes its paths lowercased.
      info("web", ["packages/web/app.tsx", "packages/web/strings.json", "packages/shared/contracts/snippetsworkflow.ts"]);
      info("sim", ["packages/web/store/sim/run.ts"]);
      info("cli", ["packages/cli/src/a.ts"]);
      const names = (changed: string[]) => projectsTouching(root, projects, changed).map((p) => p.name);
      expect(names(["packages/shared/contracts/snippetsWorkflow.ts"])).toEqual(["web"]);
      // Regression: web began importing inboxPlacement.ts after its recorded list; a sibling in the folder is enough.
      expect(names(["packages/shared/contracts/inboxPlacement.ts"])).toEqual(["web"]);
      // A package.json in a folder no project lives in reaches every program with files under it.
      expect(names(["packages/shared/package.json"])).toEqual(["web"]);
      expect(names(["packages/shared/tsconfig.json"])).toEqual(["web"]);
      expect(names(["bun.lock"])).toEqual(["web", "sim", "cli"]);
      expect(names(["package.json"])).toEqual(["web", "sim", "cli"]);
      expect(names(["packages/web/package.json"])).toEqual(["web", "sim"]);
      expect(names(["packages/cli/tsconfig.json"])).toEqual(["cli"]);
      // A JSON module the program imports is part of it. sim holds files only below that folder, so it is not reached.
      expect(names(["packages/web/strings.json"])).toEqual(["web"]);
      fs.rmSync(buildInfoPath(watchDir(root, "sim")));
      expect(names(["packages/cli/src/a.ts"])).toEqual(["sim", "cli"]);
      expect(names(["docs/a.md"])).toEqual([]);
      // Not code, yet they change what every program sees: the project list, bun's config, postinstall's patches.
      for (const f of [".codecast/check.toml", "bunfig.toml", "patches/react-native@0.81.patch"]) {
        expect(names([f, "docs/a.md"])).toEqual(["web", "sim", "cli"]);
      }
      // A package's bunfig.toml holds its test preloads, which tsc never reads.
      expect(names(["packages/cli/bunfig.toml"])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the vendored @platform mirror, recorded as bun's copy, maps back to platform/packages", () => {
    expect(bunFileDepSource("/r/node_modules/.bun/@platform+keys@file+platform+packages+keys+5be6ac63c7dc5ef2/node_modules/@platform/keys/src/catalog.ts")).toBe("platform/packages/keys/src/catalog.ts");
    expect(bunFileDepSource("/r/node_modules/.bun/@platform+fence@file+platform+packages+fence/node_modules/@platform/fence/src/index.ts")).toBe("platform/packages/fence/src/index.ts");
    expect(bunFileDepSource("/r/node_modules/.bun/react@19.1.0/node_modules/react/index.js")).toBeNull();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-bun-")));
    try {
      const projects = [
        { name: "cli", tsconfig: "packages/cli/tsconfig.json" },
        { name: "web", tsconfig: "packages/web/tsconfig.json" },
        { name: "mobile", tsconfig: "packages/mobile/tsconfig.json" },
      ];
      const bun = (pkg: string, rest: string, hash = "") => `node_modules/.bun/@platform+${pkg}@file+platform+packages+${pkg}${hash}/node_modules/@platform/${pkg}/${rest}`;
      const info = (name: string, files: string[]) => {
        const dir = watchDir(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(root, f))) }));
      };
      info("cli", ["packages/cli/src/a.ts"]);
      info("web", ["packages/web/app.tsx", "packages/web/lib/analytics.ts", bun("keys", "src/catalog.ts", "+5be6ac63c7dc5ef2"), bun("analytics", "src/index.ts"), bun("analytics", "src/webruntime.ts")]);
      info("mobile", ["packages/mobile/app.tsx", bun("keys", "src/catalog.ts", "+0123456789abcdef")]);
      const names = (changed: string[]) => projectsTouching(root, projects, changed).map((p) => p.name);
      // 411ff8710: the keys catalog alone.
      expect(names(["platform/packages/keys/src/catalog.test.ts", "platform/packages/keys/src/catalog.ts"])).toEqual(["web", "mobile"]);
      // 7e4f73eef's platform files, alone and with the rest of the commit.
      expect(names(["platform/packages/analytics/src/index.ts", "platform/packages/analytics/src/web.test.ts", "platform/packages/analytics/src/webRuntime.ts"])).toEqual(["web"]);
      expect(names(["packages/web/lib/analytics.ts", "platform/packages/analytics/src/index.ts"])).toEqual(["web"]);
      expect(names(["platform/packages/keys/package.json"])).toEqual(["web", "mobile"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed script no project places checks every project, and says which; one cli claims stays cli's", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-unplaced-")));
    try {
      const projects = [
        { name: "cli", tsconfig: "packages/cli/tsconfig.json" },
        { name: "web", tsconfig: "packages/web/tsconfig.json" },
      ];
      const info = (name: string, files: string[]) => {
        const dir = watchDir(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(root, f))) }));
      };
      info("cli", ["packages/cli/src/a.ts"]);
      info("web", ["packages/web/app.tsx"]);
      const notes: string[] = [];
      const names = (changed: string[]) => projectsTouching(root, projects, changed, (l) => notes.push(l)).map((p) => p.name);
      expect(names(["packages/cli/src/a.ts", "packages/cli/src/new.ts", "packages/cli/scripts/tool.ts"])).toEqual(["cli"]);
      expect(notes).toEqual([]);
      expect(names(["packages/cli/src/a.ts", "vendor/lib/thing.ts"])).toEqual(["cli", "web"]);
      expect(notes).toEqual(["checking every project: no project's program places vendor/lib/thing.ts"]);
      // A file that is not a script places nothing and asks for nothing.
      expect(names(["vendor/notes.md"])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectsForAsk", () => {
  let iso: IsolatedCodecastDir;
  let root: string;
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf-8" });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const names = (names: string[] = [], opts: { all?: boolean } = {}) => projectsForAsk(root, names, { ...opts, cwd: root }).projects.map((p) => p.name);
  beforeEach(() => {
    iso = isolateCodecastDir();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ask-")));
    write(".codecast/check.toml", `[projects]\ncli = "packages/cli/tsconfig.json"\nconvex = "packages/convex/tsconfig.json"\nweb = "packages/web/tsconfig.json"\n`);
    for (const [p, files] of Object.entries({ cli: ["packages/cli/src/a.ts"], convex: ["packages/convex/f.ts", "packages/shared/x.ts"], web: ["packages/web/app.tsx", "packages/convex/f.ts", "packages/shared/x.ts"] })) {
      write(`packages/${p}/tsconfig.json`, "{}");
      for (const f of files) write(f, "export {};\n");
      const dir = watchDir(root, p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(root, f))) }));
    }
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  });
  afterEach(() => {
    iso.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("bare: only the projects whose program holds a changed file, committed or not", () => {
    write("packages/cli/src/a.ts", "export const a = 1;\n");
    expect(names()).toEqual(["cli"]);
    expect(projectsForAsk(root, [], { cwd: root }).why).toMatch(/^checking cli; skipped convex, web: none of the 1 file changed since origin\/main/);
    git("commit", "-qam", "cli");
    // web compiles files in packages/convex, so a new file there may be imported by it.
    write("packages/convex/new.ts", "export {};\n");
    expect(names()).toEqual(["cli", "convex", "web"]);
    write("packages/shared/x.ts", "export const x = 1;\n");
    expect(names()).toEqual(["cli", "convex", "web"]);
  });

  test("bare: a non-ASCII path reads as itself on a host that quotes paths", () => {
    git("config", "core.quotepath", "true");
    write("packages/cli/src/a.ts", "export const a = 1;\n");
    git("commit", "-qam", "cli");
    write("packages/web/café.ts", "export {};\n");
    expect(changedFiles(root, "origin/main")).toEqual(["packages/cli/src/a.ts", "packages/web/café.ts"]);
    expect(names()).toEqual(["cli", "web"]);
    git("add", "packages/web/café.ts");
    git("commit", "-qm", "café");
    expect(changedFiles(root, "origin/main")).toEqual(["packages/cli/src/a.ts", "packages/web/café.ts"]);
  });

  test("bare: a change to convex reaches every program that compiles it", () => {
    write("packages/convex/f.ts", "export const f = 1;\n");
    expect(names()).toEqual(["convex", "web"]);
  });

  test("bare: nothing changed checks every project; a change no program holds checks none", () => {
    expect(projectsForAsk(root, [], { cwd: root })).toEqual({ projects: expect.any(Array), why: null });
    expect(names()).toEqual(["cli", "convex", "web"]);
    write("README.md", "hi\n");
    expect(names()).toEqual([]);
  });

  test("bare without an origin default branch checks every project and says why", () => {
    git("update-ref", "-d", "refs/remotes/origin/HEAD");
    git("update-ref", "-d", "refs/remotes/origin/main");
    write("packages/cli/src/a.ts", "export const a = 1;\n");
    const ask = projectsForAsk(root, [], { cwd: root });
    expect(ask.projects.map((p) => p.name)).toEqual(["cli", "convex", "web"]);
    expect(ask.why).toMatch(/no origin default branch/);
  });

  test("--all and named projects ignore what changed", () => {
    write("packages/cli/src/a.ts", "export const a = 1;\n");
    expect(names([], { all: true })).toEqual(["cli", "convex", "web"]);
    expect(names(["web"])).toEqual(["web"]);
    expect(names(["convex", "web"])).toEqual(["convex", "web"]);
    expect(projectsForAsk(root, ["web"], { cwd: root }).why).toBeNull();
  });
});

describe("a file some list holds", () => {
  let iso: IsolatedCodecastDir;
  beforeEach(() => { iso = isolateCodecastDir(); });
  afterEach(() => iso.restore());
  const info = (tree: string, name: string, files: string[]) => {
    const dir = watchDir(tree, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(buildInfoPath(dir), JSON.stringify({ fileNames: files.map((f) => path.relative(dir, path.join(tree, f))) }));
  };

  test("reaches only the programs holding it, not every program with a file beside it", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-held-")));
    try {
      const projects = [
        { name: "cli", tsconfig: "packages/cli/tsconfig.json" },
        { name: "web", tsconfig: "packages/web/tsconfig.json" },
        { name: "sim", tsconfig: "packages/web/store/sim/tsconfig.json" },
      ];
      // cli compiles one file of web/lib; web and sim compile the one changed.
      info(root, "cli", ["packages/cli/src/a.ts", "packages/web/lib/lruCache.ts"]);
      info(root, "web", ["packages/web/app.tsx", "packages/web/lib/lruCache.ts", "packages/web/lib/conversationFormat.tsx"]);
      info(root, "sim", ["packages/web/store/sim/run.ts", "packages/web/lib/conversationFormat.tsx"]);
      const names = (changed: string[]) => projectsTouching(root, projects, changed).map((p) => p.name);
      expect(names(["packages/web/lib/conversationFormat.tsx"])).toEqual(["web", "sim"]);
      expect(names(["packages/web/lib/lruCache.ts"])).toEqual(["cli", "web"]);
      // A new file beside them may be imported by any of the three.
      expect(names(["packages/web/lib/brandNew.ts"])).toEqual(["cli", "web", "sim"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the pooled lists carry an import only one checkout has seen (inboxPlacement)", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "touching-pool-")));
    try {
      const main = path.join(tmp, "main");
      const run = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" });
      fs.mkdirSync(main);
      run(main, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(main, "a.txt"), "a\n");
      run(main, "add", "a.txt");
      run(main, "commit", "-qm", "base");
      const wt = path.join(tmp, "wt");
      run(main, "worktree", "add", "-q", "-b", "wt", wt);
      const projects = [{ name: "convex", tsconfig: "packages/convex/tsconfig.json" }, { name: "web", tsconfig: "packages/web/tsconfig.json" }];
      // convex holds it everywhere; only the worktree's web list has seen web import it.
      info(main, "convex", ["packages/convex/f.ts", "packages/shared/contracts/inboxPlacement.ts"]);
      info(main, "web", ["packages/web/app.tsx", "packages/shared/contracts/other.ts"]);
      info(wt, "web", ["packages/web/app.tsx", "packages/shared/contracts/inboxPlacement.ts"]);
      expect(projectsTouching(main, projects, ["packages/shared/contracts/inboxPlacement.ts"]).map((p) => p.name)).toEqual(["convex", "web"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
