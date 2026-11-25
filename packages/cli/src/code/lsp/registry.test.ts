import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clearLspDetectionCache, resolveLspServer, type LspServerSpec } from "./registry.js";

let base = "";

function tool(dir: string, name: string): string {
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

const spec = (bin: string): LspServerSpec => ({ id: bin, name: bin, languages: [], bins: [bin], args: [], install: "", projectLocal: true });
const command = async (bin: string, root: string) => {
  const r = await resolveLspServer(spec(bin), root);
  return r.ok ? r.launch.command : null;
};

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lsp-registry-")));
});
beforeEach(() => clearLspDetectionCache());
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

test("a project's server is found in the repository, hoisted to its root", async () => {
  const repo = path.join(base, "hoisted", "repo");
  const pkg = path.join(repo, "packages", "app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  const hoisted = tool(repo, "codecast-test-ls-hoisted");
  expect(await command("codecast-test-ls-hoisted", pkg)).toBe(hoisted);
});

test("nothing above the repository root is run", async () => {
  const outer = path.join(base, "planted");
  const pkg = path.join(outer, "repo", "pkg");
  fs.mkdirSync(path.join(outer, "repo", ".git"), { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  tool(outer, "codecast-test-ls-planted");
  expect(await command("codecast-test-ls-planted", pkg)).toBeNull();
});

test("outside a repository the walk climbs through directories this user owns", async () => {
  const loose = path.join(base, "loose");
  const proj = path.join(loose, "a", "b");
  fs.mkdirSync(proj, { recursive: true });
  const found = tool(loose, "codecast-test-ls-loose");
  expect(await command("codecast-test-ls-loose", proj)).toBe(found);
});

test("a rustup proxy whose toolchain lacks the component is not installed; with it, it is", async () => {
  const rustupHome = path.join(base, "rustup");
  const bin = path.join(base, "cargo-bin");
  fs.mkdirSync(path.join(rustupHome, "toolchains", "stable-test-host", "bin"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(rustupHome, "settings.toml"), 'default_toolchain = "stable-test-host"\n');
  fs.writeFileSync(path.join(bin, "rustup"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(bin, "rustup"), 0o755);
  fs.symlinkSync("rustup", path.join(bin, "codecast-test-ra"));
  const { LSP_SERVERS } = await import("./registry.js");
  const ra = { ...LSP_SERVERS.find((s) => s.id === "rust-analyzer")!, bins: ["codecast-test-ra"], dirs: [bin] };
  const project = path.join(base, "crate");
  fs.mkdirSync(project, { recursive: true });
  const prev = process.env.RUSTUP_HOME;
  process.env.RUSTUP_HOME = rustupHome;
  try {
    const missing = await resolveLspServer(ra, project);
    expect(missing).toEqual({ ok: false, reason: "the codecast-test-ra component is not installed for the stable-test-host toolchain" });

    const component = path.join(rustupHome, "toolchains", "stable-test-host", "bin", "codecast-test-ra");
    fs.writeFileSync(component, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(component, 0o755);
    clearLspDetectionCache();
    expect((await resolveLspServer(ra, project)).ok).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.RUSTUP_HOME;
    else process.env.RUSTUP_HOME = prev;
  }
});
