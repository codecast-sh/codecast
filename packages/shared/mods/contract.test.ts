import { describe, expect, test } from "bun:test";
import { permissionsSig, validateManifest } from "../contracts/mods";
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
});
