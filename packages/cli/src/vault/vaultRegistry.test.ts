import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  addVault,
  clearProjectVaultCache,
  findVault,
  homeForConfigDir,
  listVaults,
  projectVaults,
  registeredVaults,
  removeVault,
  setVaultMirroring,
  setVaultNoteCount,
  vaultId,
} from "./vaultRegistry.js";

let base = "";
let configDir = "";
let notesDir = "";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-registry-"));
  configDir = path.join(base, ".codecast");
  notesDir = path.join(base, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

function rawConfig(): any {
  return JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
}

describe("vaultRegistry", () => {
  test("add, list, find and remove round-trip", () => {
    expect(listVaults(configDir)).toEqual([]);

    const added = addVault(configDir, notesDir);
    expect(added.id).toMatch(/^[0-9a-f]{12}$/);
    expect(added.id).toBe(vaultId(notesDir));
    expect(added.root).toBe(notesDir);
    expect(added.name).toBe("notes");
    expect(added.added_at).toBeGreaterThan(0);

    expect(listVaults(configDir)).toHaveLength(1);
    expect(findVault(configDir, added.id)?.root).toBe(notesDir);
    expect(findVault(configDir, notesDir)?.id).toBe(added.id);
    expect(findVault(configDir, path.join(base, "nope"))).toBeNull();

    expect(removeVault(configDir, added.id)?.id).toBe(added.id);
    expect(listVaults(configDir)).toEqual([]);
    expect(removeVault(configDir, added.id)).toBeNull();
  });

  test("re-adding the same root does not duplicate, and --name renames", () => {
    const first = addVault(configDir, notesDir);
    const again = addVault(configDir, notesDir);
    expect(again.id).toBe(first.id);
    expect(listVaults(configDir)).toHaveLength(1);

    addVault(configDir, notesDir, "Second Brain");
    expect(listVaults(configDir)[0].name).toBe("Second Brain");
    expect(listVaults(configDir)).toHaveLength(1);
  });

  test("a relative path registers as its absolute form", () => {
    const rel = path.relative(process.cwd(), notesDir);
    const added = addVault(configDir, rel);
    expect(added.root).toBe(path.resolve(notesDir));
    expect(findVault(configDir, notesDir)?.id).toBe(added.id);
  });

  test("rejects a missing directory and a file", () => {
    expect(() => addVault(configDir, path.join(base, "missing"))).toThrow(/No such directory/);
    const file = path.join(base, "note.md");
    fs.writeFileSync(file, "x");
    expect(() => addVault(configDir, file)).toThrow(/Not a directory/);
  });

  test("leaves every other config field alone", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ auth_token: "keep-me", sync_mode: "all" }, null, 2),
    );

    addVault(configDir, notesDir);
    expect(rawConfig().auth_token).toBe("keep-me");
    expect(rawConfig().sync_mode).toBe("all");

    removeVault(configDir, notesDir);
    expect(rawConfig().auth_token).toBe("keep-me");
    expect(rawConfig().vaults).toEqual([]);
  });

  test("a corrupt config reads as no vaults instead of throwing", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{ not json");
    expect(listVaults(configDir)).toEqual([]);
  });

  test("note counts are written back only when they change", () => {
    const vault = addVault(configDir, notesDir);
    setVaultNoteCount(configDir, vault.id, 42);
    expect(listVaults(configDir)[0].note_count).toBe(42);

    const before = fs.statSync(path.join(configDir, "config.json")).mtimeMs;
    setVaultNoteCount(configDir, vault.id, 42);
    expect(fs.statSync(path.join(configDir, "config.json")).mtimeMs).toBe(before);
  });
});

// --- Project vaults --------------------------------------------------------
// Discovery derives its scope from the config directory it was handed, so these
// build a whole fake home: <base>/.codecast for the config, <base>/src/* for
// the projects. Nothing here can see the real machine's projects, which is the
// property being tested as much as the discovery itself.

describe("project vaults", () => {
  let home = "";
  let cfg = "";

  function project(parent: string, name: string, build: (dir: string) => void): string {
    const dir = path.join(home, parent, name);
    fs.mkdirSync(dir, { recursive: true });
    build(dir);
    return dir;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vault-home-"));
    cfg = path.join(home, ".codecast");
    fs.mkdirSync(cfg, { recursive: true });
    clearProjectVaultCache();
  });

  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    clearProjectVaultCache();
  });

  test("a config directory only ever discovers its own home", () => {
    // The bug this exists to prevent: a temp config directory listing the
    // developer's real projects, because discovery read process.env.HOME
    // instead of the config it was handed.
    expect(homeForConfigDir(cfg)).toBe(home);
    expect(listVaults(cfg)).toEqual([]);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vault-nohome-"));
    expect(projectVaults(path.join(empty, ".codecast"))).toEqual([]);
    try { fs.rmSync(empty, { recursive: true, force: true }); } catch {}
  });

  test("projects with markdown are offered, projects without are not", () => {
    project("src", "with-readme", (d) => fs.writeFileSync(path.join(d, "README.md"), "# hi"));
    project("dev", "with-docs", (d) => {
      fs.mkdirSync(path.join(d, "docs"));
      fs.writeFileSync(path.join(d, "docs", "guide.md"), "guide");
    });
    project("src", "code-only", (d) => fs.writeFileSync(path.join(d, "main.ts"), "export {}"));

    const found = projectVaults(cfg);
    expect(found.map((v) => v.name)).toEqual(["with-docs", "with-readme"]);
    expect(found.every((v) => v.kind === "project")).toBe(true);
    // The home hint travels with the vault so the browser doesn't re-derive it.
    expect(found.find((v) => v.name === "with-docs")?.home).toBe("docs");
    expect(found.find((v) => v.name === "with-readme")?.home).toBeUndefined();
    // A discovered vault claims no note count: the cheap probe cannot know one.
    expect(found.every((v) => v.note_count === undefined)).toBe(true);
  });

  test("discovery is ephemeral until the vault is opened", () => {
    const dir = project("src", "notes-repo", (d) => fs.writeFileSync(path.join(d, "README.md"), "# hi"));

    // Offered, but nothing has been written to config.json yet.
    expect(projectVaults(cfg)).toHaveLength(1);
    expect(registeredVaults(cfg)).toEqual([]);
    expect(fs.existsSync(path.join(cfg, "config.json"))).toBe(false);

    // Resolving one — which is what every scan, read and watch does — is what
    // registers it.
    const opened = findVault(cfg, vaultId(dir));
    expect(opened?.root).toBe(dir);
    expect(opened?.kind).toBe("project");
    expect(opened?.added_at).toBeGreaterThan(0);

    const registered = registeredVaults(cfg);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.root).toBe(dir);
    // And it is no longer offered a second time.
    expect(projectVaults(cfg)).toEqual([]);
    expect(listVaults(cfg)).toHaveLength(1);
  });

  test("a materialized project vault behaves like any other vault", () => {
    const dir = project("src", "notes-repo", (d) => fs.writeFileSync(path.join(d, "README.md"), "# hi"));
    const id = findVault(cfg, dir)!.id;

    // The things a discovered vault could not hold: a note count and a mirror
    // flag. Both work once it is a real row.
    setVaultNoteCount(cfg, id, 42);
    expect(findVault(cfg, id)?.note_count).toBe(42);
    setVaultMirroring(cfg, id, true);
    expect(findVault(cfg, id)?.mirror).toBe(true);
  });

  test("resolving by root path registers it too", () => {
    const dir = project("repos", "by-path", (d) => fs.writeFileSync(path.join(d, "README.md"), "# hi"));
    expect(findVault(cfg, dir)?.id).toBe(vaultId(dir));
    expect(registeredVaults(cfg)).toHaveLength(1);
  });

  test("a hand-registered root is not offered a second time", () => {
    const dir = project("src", "both", (d) => fs.writeFileSync(path.join(d, "README.md"), "# hi"));
    addVault(cfg, dir, "My Notes");
    expect(projectVaults(cfg)).toEqual([]);
    const all = listVaults(cfg);
    expect(all).toHaveLength(1);
    // The hand registration wins, name and all.
    expect(all[0]!.name).toBe("My Notes");
    expect(all[0]!.kind).toBeUndefined();
  });

  test("removing a project vault makes it stay removed", () => {
    const dir = project("src", "unwanted", (d) => fs.writeFileSync(path.join(d, "README.md"), "# hi"));
    expect(removeVault(cfg, vaultId(dir))?.root).toBe(dir);
    // Without the hidden list, discovery would re-offer it seconds later and
    // the removal would read as having failed.
    expect(projectVaults(cfg)).toEqual([]);
    expect(listVaults(cfg)).toEqual([]);

    // Adding it back by hand is a clearer statement of intent than the removal.
    addVault(cfg, dir);
    expect(listVaults(cfg)).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(cfg, "config.json"), "utf-8"));
    expect(saved.vaults_hidden ?? []).not.toContain(dir);
  });

  test("removing an opened project vault also stops it being re-offered", () => {
    const dir = project("src", "opened-then-removed", (d) =>
      fs.writeFileSync(path.join(d, "README.md"), "# hi"),
    );
    findVault(cfg, dir);
    expect(registeredVaults(cfg)).toHaveLength(1);
    expect(removeVault(cfg, dir)?.root).toBe(dir);
    expect(listVaults(cfg)).toEqual([]);
  });

  test("registered vaults come first, projects after, each in name order", () => {
    const outside = path.join(home, "notes");
    fs.mkdirSync(outside, { recursive: true });
    addVault(cfg, outside, "Zeta Notes");
    project("src", "beta", (d) => fs.writeFileSync(path.join(d, "README.md"), "b"));
    project("src", "alpha", (d) => fs.writeFileSync(path.join(d, "README.md"), "a"));

    expect(listVaults(cfg).map((v) => v.name)).toEqual(["Zeta Notes", "alpha", "beta"]);
  });
});
