import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearRepoScopeCache,
  isRepoVaultRoot,
  isVaultPathIgnored,
  isVaultServablePath,
  normalizeVaultPath,
  probeProjectVault,
  realVaultRoot,
  resolveVaultPath,
  revealCommand,
  scanVault,
  vaultContentType,
  vaultProjectHome,
  vaultRelativePath,
} from "./vaultScope.js";

let root = "";
let outside = "";

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-scope-"));
  root = path.join(base, "vault");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "notes", "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, "index.md"), "# index");
  fs.writeFileSync(path.join(root, "notes", "one.md"), "one");
  fs.writeFileSync(path.join(root, "notes", "sub", "two.md"), "two");
  fs.writeFileSync(path.join(root, "notes", "pic.png"), "png");
  fs.writeFileSync(path.join(root, "notes", "ignore.txt"), "txt");
  fs.writeFileSync(path.join(root, ".obsidian", "app.json"), "{}");
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
});

afterEach(() => {
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch {}
});

describe("normalizeVaultPath", () => {
  test("normalizes separators, leading slashes and dot segments", () => {
    expect(normalizeVaultPath("notes/one.md")).toBe("notes/one.md");
    expect(normalizeVaultPath("/notes/one.md")).toBe("notes/one.md");
    expect(normalizeVaultPath("./notes//one.md")).toBe("notes/one.md");
    expect(normalizeVaultPath("notes\\one.md")).toBe("notes/one.md");
  });

  test("rejects traversal and unusable paths", () => {
    expect(normalizeVaultPath("../one.md")).toBeNull();
    expect(normalizeVaultPath("notes/../../one.md")).toBeNull();
    expect(normalizeVaultPath("notes/one\0.md")).toBeNull();
    expect(normalizeVaultPath("C:\\notes\\one.md")).toBeNull();
  });
});

describe("resolveVaultPath", () => {
  test("resolves a path inside the vault", () => {
    expect(resolveVaultPath(root, "notes/one.md")).toBe(path.join(realVaultRoot(root), "notes", "one.md"));
  });

  test("resolves a file that does not exist yet (a create target)", () => {
    expect(resolveVaultPath(root, "notes/new.md")).toBe(path.join(realVaultRoot(root), "notes", "new.md"));
  });

  test("rejects traversal out of the vault", () => {
    expect(resolveVaultPath(root, "../outside/secret.md")).toBeNull();
    expect(resolveVaultPath(root, "notes/../../outside/secret.md")).toBeNull();
    // A leading slash reads as vault-relative, never as the system root.
    expect(resolveVaultPath(root, "/etc/passwd")).toBe(path.join(realVaultRoot(root), "etc", "passwd"));
  });

  test("rejects ignored segments", () => {
    expect(resolveVaultPath(root, ".obsidian/app.json")).toBeNull();
    expect(resolveVaultPath(root, ".git/config")).toBeNull();
    expect(resolveVaultPath(root, "notes/node_modules/x.md")).toBeNull();
  });

  test("rejects a symlinked file pointing out of the vault", () => {
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));
    expect(resolveVaultPath(root, "link.md")).toBeNull();
  });

  test("rejects a path through a symlinked directory", () => {
    fs.symlinkSync(outside, path.join(root, "linked"));
    expect(resolveVaultPath(root, "linked/secret.md")).toBeNull();
    // Including a file that does not exist yet — a write must not escape either.
    expect(resolveVaultPath(root, "linked/new.md")).toBeNull();
  });

  test("a symlinked root is not an escape", () => {
    const alias = path.join(path.dirname(root), "alias");
    fs.symlinkSync(root, alias);
    expect(resolveVaultPath(alias, "notes/one.md")).toBe(path.join(realVaultRoot(root), "notes", "one.md"));
  });
});

describe("vaultRelativePath", () => {
  test("maps absolute paths back, and refuses outsiders", () => {
    expect(vaultRelativePath(root, path.join(root, "notes", "one.md"))).toBe("notes/one.md");
    expect(vaultRelativePath(root, path.join(outside, "secret.md"))).toBeNull();
  });
});

describe("scope predicates", () => {
  test("serves markdown and assets only", () => {
    expect(isVaultServablePath("a.md")).toBe(true);
    expect(isVaultServablePath("a.MARKDOWN")).toBe(true);
    expect(isVaultServablePath("a.png")).toBe(true);
    expect(isVaultServablePath("a.txt")).toBe(false);
    expect(isVaultServablePath("a.sh")).toBe(false);
  });

  test("content types let the browser render attachments", () => {
    expect(vaultContentType("a.md")).toBe("text/markdown; charset=utf-8");
    expect(vaultContentType("a.PNG")).toBe("image/png");
    expect(vaultContentType("a.pdf")).toBe("application/pdf");
  });
});

describe("scanVault", () => {
  test("lists servable files and directories, sorted, ignoring the rest", async () => {
    const files = await scanVault(root);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("index.md");
    expect(paths).toContain("notes/one.md");
    expect(paths).toContain("notes/sub/two.md");
    expect(paths).toContain("notes/pic.png");
    expect(paths).toContain("notes");
    expect(paths).toContain("notes/sub");
    expect(paths).not.toContain("notes/ignore.txt");
    expect(paths.some((p) => p.startsWith(".obsidian"))).toBe(false);

    const dir = files.find((f) => f.path === "notes");
    expect(dir?.dir).toBe(true);
    const note = files.find((f) => f.path === "notes/one.md");
    expect(note?.size).toBe(3);
    expect(note?.mtime).toBeGreaterThan(0);
  });

  test("skips symlinks entirely", async () => {
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));
    fs.symlinkSync(outside, path.join(root, "linked"));
    const paths = (await scanVault(root)).map((f) => f.path);
    expect(paths).not.toContain("link.md");
    expect(paths).not.toContain("linked");
  });
});

describe("revealCommand", () => {
  test("macOS selects the file, or opens it with the default app", () => {
    expect(revealCommand("darwin", "/v/a note.md", "reveal")).toEqual({
      cmd: "open",
      args: ["-R", "/v/a note.md"],
    });
    expect(revealCommand("darwin", "/v/a note.md", "open")).toEqual({
      cmd: "open",
      args: ["/v/a note.md"],
    });
  });

  test("Windows joins the selection flag to the path with no space", () => {
    // A space after the comma makes explorer open Documents instead — silent
    // and wrong, which is exactly why this is pinned.
    const { cmd, args } = revealCommand("win32", "C:\\v\\note.md", "reveal");
    expect(cmd).toBe("explorer");
    expect(args).toEqual(["/select,C:\\v\\note.md"]);
    expect(args[0]).not.toContain(", ");
  });

  test("Linux falls back to the containing folder, since there is no select verb", () => {
    expect(revealCommand("linux", "/v/sub/note.md", "reveal")).toEqual({
      cmd: "xdg-open",
      args: ["/v/sub"],
    });
    expect(revealCommand("linux", "/v/sub/note.md", "open")).toEqual({
      cmd: "xdg-open",
      args: ["/v/sub/note.md"],
    });
  });

  test("the path is always its own argv entry, so a filename cannot inject", () => {
    const nasty = '/v/note; rm -rf ~.md';
    for (const p of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      const { args } = revealCommand(p, nasty, "open");
      expect(args.some((a) => a.includes(nasty))).toBe(true);
      expect(args.length).toBeLessThanOrEqual(2);
    }
  });
});

// --- Repo scope ------------------------------------------------------------
// A vault whose root is a git repo hides build output, tool directories and
// whatever .gitignore names. A plain notes vault must keep showing all of it:
// a folder called "build" in someone's writing is a topic, not a target dir.

describe("repo scope", () => {
  let repo = "";
  let plain = "";

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-repo-"));
    repo = path.join(base, "repo");
    plain = path.join(base, "plain");
    for (const dir of [repo, plain]) {
      fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
      fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
      fs.mkdirSync(path.join(dir, ".next"), { recursive: true });
      fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
      fs.writeFileSync(path.join(dir, "README.md"), "# readme");
      fs.writeFileSync(path.join(dir, "dist", "bundle.md"), "generated");
      fs.writeFileSync(path.join(dir, "docs", "guide.md"), "guide");
      fs.writeFileSync(path.join(dir, ".next", "page.md"), "built");
      fs.writeFileSync(path.join(dir, ".github", "CONTRIBUTING.md"), "contributing");
    }
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    clearRepoScopeCache();
  });

  afterEach(() => {
    try { fs.rmSync(path.dirname(repo), { recursive: true, force: true }); } catch {}
    clearRepoScopeCache();
  });

  test("build output and tool dot-directories are hidden in a repo", () => {
    expect(isRepoVaultRoot(repo)).toBe(true);
    expect(isVaultPathIgnored(repo, "dist/bundle.md")).toBe(true);
    expect(isVaultPathIgnored(repo, ".next/page.md")).toBe(true);
    // Dot-directories people actually write markdown into are the exception.
    expect(isVaultPathIgnored(repo, ".github/CONTRIBUTING.md")).toBe(false);
    expect(isVaultPathIgnored(repo, "docs/guide.md")).toBe(false);
    expect(isVaultPathIgnored(repo, "README.md")).toBe(false);
  });

  test("the same names stay visible in a plain vault", () => {
    expect(isRepoVaultRoot(plain)).toBe(false);
    expect(isVaultPathIgnored(plain, "dist/bundle.md")).toBe(false);
    expect(isVaultPathIgnored(plain, ".next/page.md")).toBe(false);
    // The always-ignored set still applies to every vault.
    expect(isVaultPathIgnored(plain, "node_modules/pkg/readme.md")).toBe(true);
    expect(isVaultPathIgnored(plain, ".obsidian/app.json")).toBe(true);
  });

  test("scanVault hides what the repo rules hide", async () => {
    const paths = (await scanVault(repo)).map((f) => f.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("docs/guide.md");
    expect(paths).toContain(".github/CONTRIBUTING.md");
    expect(paths).not.toContain("dist/bundle.md");
    expect(paths).not.toContain(".next/page.md");
    // The directories themselves are gone too, not just their contents.
    expect(paths).not.toContain("dist");
    expect(paths).not.toContain(".next");
  });

  test("resolveVaultPath refuses a path the scan would not list", () => {
    expect(resolveVaultPath(repo, "dist/bundle.md")).toBeNull();
    expect(resolveVaultPath(plain, "dist/bundle.md")).not.toBeNull();
  });

  test("root .gitignore names are honored, negations are not guessed at", () => {
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      ["# comment", "generated/", "/public/built", "secret.md", "keep-me", "!keep-me", "*.log"].join("\n"),
    );
    clearRepoScopeCache();
    expect(isVaultPathIgnored(repo, "generated/notes.md")).toBe(true);
    // A name with no slash matches at any depth, as git itself does.
    expect(isVaultPathIgnored(repo, "docs/generated/notes.md")).toBe(true);
    expect(isVaultPathIgnored(repo, "secret.md")).toBe(true);
    // Anchored patterns match from the root only.
    expect(isVaultPathIgnored(repo, "public/built/index.md")).toBe(true);
    expect(isVaultPathIgnored(repo, "docs/public/built/index.md")).toBe(false);
    // A re-included name is left visible rather than modelled by guesswork.
    expect(isVaultPathIgnored(repo, "keep-me/notes.md")).toBe(false);
    // Globs are skipped entirely — hiding too much loses a note.
    expect(isVaultPathIgnored(repo, "notes.log.md")).toBe(false);
  });

  test("a .gitignore in a plain vault is not read at all", () => {
    fs.writeFileSync(path.join(plain, ".gitignore"), "docs/\n");
    clearRepoScopeCache();
    expect(isVaultPathIgnored(plain, "docs/guide.md")).toBe(false);
  });
});

describe("probeProjectVault", () => {
  let base = "";

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-probe-"));
  });

  afterEach(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });

  function project(name: string, build: (dir: string) => void): string {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    build(dir);
    return dir;
  }

  test("a docs directory becomes the home", () => {
    const dir = project("with-docs", (d) => {
      fs.mkdirSync(path.join(d, "docs"));
      fs.writeFileSync(path.join(d, "README.md"), "readme");
      fs.writeFileSync(path.join(d, "docs", "guide.md"), "guide");
    });
    expect(probeProjectVault(dir)).toEqual({ hasNotes: true, home: "docs" });
    expect(vaultProjectHome(dir)).toBe("docs");
  });

  test("an empty docs directory is a worse landing than the root", () => {
    const dir = project("empty-docs", (d) => {
      fs.mkdirSync(path.join(d, "docs"));
      fs.writeFileSync(path.join(d, "README.md"), "readme");
    });
    expect(probeProjectVault(dir)).toEqual({ hasNotes: true, home: "" });
  });

  test("a root README alone is enough to offer the project", () => {
    const dir = project("bare", (d) => fs.writeFileSync(path.join(d, "README.md"), "readme"));
    expect(probeProjectVault(dir)).toEqual({ hasNotes: true, home: "" });
  });

  test("a project with no markdown the probe can see is not offered", () => {
    const dir = project("code-only", (d) => {
      fs.mkdirSync(path.join(d, "src"));
      fs.writeFileSync(path.join(d, "src", "index.ts"), "export {}");
      // Markdown buried in src is a known, documented blind spot: finding it
      // would cost a full walk of every project on the machine.
      fs.writeFileSync(path.join(d, "src", "notes.md"), "buried");
    });
    expect(probeProjectVault(dir).hasNotes).toBe(false);
  });

  test("a directory that cannot be read is not offered", () => {
    expect(probeProjectVault(path.join(base, "nope"))).toEqual({ hasNotes: false, home: "" });
  });
});
