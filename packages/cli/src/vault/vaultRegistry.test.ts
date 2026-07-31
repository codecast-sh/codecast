import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  addVault,
  findVault,
  listVaults,
  removeVault,
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
