import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isVaultServablePath,
  normalizeVaultPath,
  realVaultRoot,
  resolveVaultPath,
  revealCommand,
  scanVault,
  vaultContentType,
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
