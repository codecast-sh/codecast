import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { artifactView, specForCli } from "@codecast/shared/artifacts";
import { lifecycleGuide, parseDocRef, parseOpsInput, readNotes, registerBoardCommand, registerDataCommand, registerSheetCommand, resolveRmKeys } from "./liveArtifactCommand";

const ID = "k17abcdefghijklmnopqrstuvwxyz012";

describe("cast board|sheet|data input", () => {
  test("a doc is an id, doc:<id>, or its page URL", () => {
    expect(parseDocRef(ID)).toBe(ID);
    expect(parseDocRef(`doc:${ID}`)).toBe(ID);
    expect(parseDocRef(`https://codecast.sh/docs/${ID}?view=minimal`)).toBe(ID);
    expect(() => parseDocRef("ct-123")).toThrow(/Not an artifact id/);
  });

  test("ops come as an array or an object with a cursor", () => {
    expect(parseOpsInput('[{"k":"el_a","del":true}]').ops).toHaveLength(1);
    const withPos = parseOpsInput('{"ops":[{"k":"el_a","set":{"x":1}}],"position":{"point":{"x":1,"y":2}},"status":"moving"}');
    expect(withPos.position).toEqual({ point: { x: 1, y: 2 } });
    expect(withPos.status).toBe("moving");
  });

  test("bad ops are refused before anything is sent", () => {
    expect(() => parseOpsInput("not json")).toThrow(/JSON/);
    expect(() => parseOpsInput('{"nope":1}')).toThrow(/array of ops/);
    expect(() => parseOpsInput('[{"k":"el_a","set":{"rev":1}}]')).toThrow(/reserved/);
  });
});

describe("cast board|sheet|data: the whole life of an artifact", () => {
  const program = () => {
    const p = new Command();
    const deps = { getCliEndpoint: () => ({ siteUrl: "", apiToken: "" }), detectCurrentSessionId: () => null } as any;
    registerBoardCommand(p, deps);
    registerSheetCommand(p, deps);
    registerDataCommand(p, deps);
    return p;
  };

  test("every group carries the doc-level verbs, and no product verb shadows one", () => {
    // Commander refuses a second command of the same name, so registering is itself the collision check.
    const p = program();
    for (const cli of ["board", "sheet", "data"]) {
      const names = p.commands.find((c) => c.name() === cli)!.commands.map((c) => c.name());
      for (const verb of ["create", "copy", "ls", "read", "apply", "rm", "rename", "share", "unshare", "access", "project", "archive", "unarchive", "history", "restore"]) {
        expect(names).toContain(verb);
      }
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("the guide names every doc-level verb with its group", () => {
    for (const spec of [specForCli("board")!, specForCli("sheet")!, specForCli("data")!]) {
      const text = lifecycleGuide(spec).join("\n");
      for (const verb of ["create", "copy", "read", "apply", "rm", "rename", "share", "unshare", "access", "project", "archive", "unarchive", "draft", "history", "restore", "comment"]) {
        expect(text).toContain(`cast ${spec.cli} ${verb}`);
      }
    }
  });

  test("read says what an archived or view-only artifact needs next, and how to write a draft", () => {
    expect(readNotes("sheet", "sheet", "d1", { archived: true })).toEqual(["archived: read only. `cast sheet unarchive d1` brings it back."]);
    expect(readNotes("board", "board", "d1", { can_edit: false })[0]).toMatch(/view only.*cast board comment/);
    expect(readNotes("data", "dashboard", "d1", { draft: { by_name: "Rosa" } })[0]).toMatch(/--draft.*cast data draft d1 save/);
    expect(readNotes("board", "board", "d1", { can_edit: true })).toEqual([]);
  });

  test("rm takes element keys or a sheet's cell references, and names the ones that match nothing", () => {
    const sheet = specForCli("sheet")!;
    const view = artifactView("sheet", "S", [
      { key: "tab:Sheet1", kind: "tab", rev: 1, name: "Sheet1", order: 0 } as any,
      { key: "c:Sheet1!A1", kind: "cell", rev: 2, v: "x" } as any,
    ]);
    expect(resolveRmKeys(sheet, view, ["A1", "c:Sheet1!A1"])).toEqual(["c:Sheet1!A1"]);
    expect(() => resolveRmKeys(sheet, view, ["B9"])).toThrow(/no element B9.*cast sheet clear/);
    const board = specForCli("board")!;
    const bview = artifactView("board", "B", [{ key: "el_a", kind: "sticky", rev: 1, x: 0, y: 0 } as any]);
    expect(resolveRmKeys(board, bview, ["el_a"])).toEqual(["el_a"]);
    expect(() => resolveRmKeys(board, bview, ["el_a", "el_gone"])).toThrow(/no element el_gone in this board/);
  });
});

describe("board verbs an agent reaches for", () => {
  test("frame takes its title as the first word or as --title, never a key as the title", () => {
    const frame = specForCli("board")!.verbs!.frame;
    const view = artifactView("board", "B", [
      { key: "el_a", kind: "sticky", rev: 1, x: 0, y: 0, w: 200, h: 160 } as any,
      { key: "el_b", kind: "sticky", rev: 2, x: 240, y: 0, w: 200, h: 160 } as any,
    ]);
    for (const args of [["Top", "el_a", "el_b"], ["el_a", "el_b", "--title", "Top"], ["--title", "Top", "el_a", "el_b"]]) {
      const r = frame.run(view, args);
      expect((r.ops[0] as any).put.title).toBe("Top");
      expect(r.status).toMatch(/framed 2 as "Top"/);
    }
  });
});
