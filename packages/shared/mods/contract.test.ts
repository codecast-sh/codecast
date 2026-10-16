import { describe, expect, test } from "bun:test";
import { permissionsSig, secretFor, validateManifest } from "../contracts/mods";
import { inspectModSource } from "./inspect";

describe("mods contract guards", () => {
  test("a mod cannot claim a programming language's fence (its code would reach the mod past its grants)", () => {
    for (const lang of ["typescript", "javascript", "go", "rust", "env", "dockerfile", "sql", "python"]) {
      const res = validateManifest({ name: "grabby", fences: [{ lang }] });
      expect(res.ok).toBe(false);
    }
    expect(validateManifest({ name: "bugs", fences: [{ lang: "bug" }] }).ok).toBe(true);
  });

  test("the permissions signature changes when grants widen and not when they reorder", () => {
    const a = permissionsSig({ permissions: { read: ["tasks", "sessions"], write: ["tasks"] } });
    expect(permissionsSig({ permissions: { read: ["sessions", "tasks"], write: ["tasks"] } })).toBe(a);
    expect(permissionsSig({ permissions: { read: ["sessions", "tasks"], write: ["tasks", "sessions"] } })).not.toBe(a);
    expect(permissionsSig({ permissions: { read: "*", write: ["tasks"] } })).not.toBe(a);
    expect(permissionsSig({ permissions: { read: ["tasks", "sessions"], write: ["tasks"], fetch: ["https://x.io"] } })).not.toBe(a);
  });

  test("the inspector sees calls behind a type argument", () => {
    const i = inspectModSource({ "ui.tsx": `on("ui.render", { pane: "p" }, async ($) => { await $.local.get<number[]>("x"); await $.data.list("tasks"); })` }, { name: "m-m" });
    expect(i.calls).toContain("local.get");
    expect(i.missing).toContain('permissions.read "tasks"');
  });

  test("an external kind takes a boolean flag and must answer object.resolve", () => {
    const manifest = { name: "people", objects: [{ prefix: "contact", title: "Contact", external: true }] };
    expect(validateManifest(manifest).ok).toBe(true);
    expect(validateManifest({ name: "people", objects: [{ prefix: "contact", title: "Contact", external: "yes" }] }).ok).toBe(false);
    expect(inspectModSource({ "ui.tsx": `on("ui.render", { object: "contact" }, async () => null)` }, manifest as any).unserved.join()).toContain('external object "contact"');
    expect(inspectModSource({ "ui.tsx": `on("object.resolve", { object: "contact" }, async () => null)` }, manifest as any).unserved).toEqual([]);
  });
});

describe("mod secrets and connectors", () => {
  const base = { name: "union", permissions: { fetch: ["https://api.union.test"] } };

  test("a secret names the origins it may go to, and permissions.fetch must list them", () => {
    expect(validateManifest({ ...base, secrets: [{ name: "UNION_KEY", origins: ["https://api.union.test"] }] }).ok).toBe(true);
    const off = validateManifest({ ...base, secrets: [{ name: "UNION_KEY", origins: ["https://other.test"] }] });
    expect(off.ok ? [] : off.errors).toEqual([`secrets: "UNION_KEY" goes to an origin permissions.fetch does not list`]);
    const bad = validateManifest({ ...base, secrets: [{ name: "union key", origins: [] }] });
    expect(bad.ok).toBe(false);
  });

  test("a fetch carries a secret only toward its declared origins", () => {
    const check = validateManifest({ ...base, secrets: [{ name: "UNION_KEY", origins: ["https://api.union.test"] }] });
    if (!check.ok) throw new Error("manifest");
    expect(secretFor(check.manifest, "UNION_KEY", "https://api.union.test/x").ok).toBe(true);
    expect(secretFor(check.manifest, "UNION_KEY", "https://api.union.test.evil.com/x").ok).toBe(false);
    expect(secretFor(check.manifest, "NOPE", "https://api.union.test/x").ok).toBe(false);
  });

  test("connectors join the install signature only when granted", () => {
    expect(permissionsSig(base as any)).toBe("r=;w=;f=https://api.union.test");
    expect(permissionsSig({ permissions: { ...base.permissions, connectors: ["union"] } } as any)).toBe("r=;w=;f=https://api.union.test;c=union");
    expect(validateManifest({ ...base, permissions: { connectors: ["union"] } }).ok).toBe(true);
    expect(validateManifest({ ...base, permissions: { connectors: "union" } }).ok).toBe(false);
  });
});
