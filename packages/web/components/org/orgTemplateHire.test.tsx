import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrgTemplateCommand } from "./orgTemplateCommand";

const workspace = { kind: "team" as const, id: "team-1", name: "Team" };
const projects = [{ _id: "project-1", title: "Product", workspace: "team:team-1" }];
const draft = { projectId: "project-1", projectPath: "/src/product", folder: "/src/templates/growth", instance: "product-growth" };

describe("org template command handoff", () => {
  test("pins the project and workspace and stops after the proposal", () => {
    const result = buildOrgTemplateCommand(draft, projects, workspace);
    expect(result.error).toBeUndefined();
    expect(result.command).toContain("cd -- '/src/product'");
    expect(result.command).toContain("cast org template inspect '/src/templates/growth'");
    expect(result.command).toContain("--project 'project-1' --instance 'product-growth' --team 'team-1'");
    expect(result.command).not.toMatch(/reconcile|--apply|--trust|--caps|trigger|publish|spend|role create/);
  });

  test("personal is explicit and cannot select another workspace's project", () => {
    const personal = { kind: "user" as const, id: "user-1", name: "Personal" };
    expect(buildOrgTemplateCommand(draft, [{ ...projects[0], workspace: "user:user-1" }], personal).command).toEndWith("--personal");
    expect(buildOrgTemplateCommand(draft, projects, personal).command).toBeUndefined();
    expect(buildOrgTemplateCommand(draft, [{ ...projects[0], workspace: "user:user-2" }], personal).command).toBeUndefined();
    expect(buildOrgTemplateCommand(draft, [{ ...projects[0], workspace: undefined }], personal).command).toBeUndefined();
  });

  test("requires a current project, absolute host paths and a valid instance", () => {
    for (const patch of [{ projectId: "" }, { projectId: "unknown" }, { projectPath: "" }, { projectPath: "~/src/product" }, { projectPath: "/" }, { folder: "./growth" }, { folder: "/src\n/growth" }, { folder: "/src\0/growth" }, { instance: "" }, { instance: "$(touch gotcha)" }, { instance: "A" }, { instance: "a".repeat(49) }]) {
      expect(buildOrgTemplateCommand({ ...draft, ...patch }, projects, workspace).command).toBeUndefined();
    }
    expect(buildOrgTemplateCommand(draft, [], workspace).error).toContain("existing project");
    expect(buildOrgTemplateCommand(draft, projects, { ...workspace, id: "" }).command).toBeUndefined();
  });

  test("the shell receives literal spaces, quotes, substitutions and metacharacters", () => {
    const root = mkdtempSync(join(tmpdir(), "org-template-command-"));
    const projectPath = join(root, "owner's repo; $(printf INJECTED) `printf UNSAFE` $USER");
    mkdirSync(projectPath);
    const folder = "/templates/it's growth; $(printf INJECTED) `printf UNSAFE` $HOME & *";
    const result = buildOrgTemplateCommand({ ...draft, projectPath, folder }, projects, workspace);
    try {
      const shell = Bun.spawnSync(["bash", "-c", `cast() { printf '%s\\0' "$@"; }; ${result.command}`]);
      expect(shell.exitCode).toBe(0);
      expect(shell.stdout.toString().split("\0").slice(0, -1)).toEqual([
        "org", "template", "inspect", folder,
        "org", "template", "install", folder, "--project", "project-1", "--instance", "product-growth", "--team", "team-1",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mounted hire flow preserves manual drafts and never creates a template role directly", () => {
    const child = Bun.spawnSync(["bun", "run", new URL("./orgTemplateHire.mount.test.tsx", import.meta.url).pathname], { cwd: new URL("../../", import.meta.url).pathname, timeout: 60_000 });
    expect(child.stdout.toString() + child.stderr.toString()).toContain("org template hire mount: passed");
    expect(child.exitCode).toBe(0);
  }, 65_000);
});
