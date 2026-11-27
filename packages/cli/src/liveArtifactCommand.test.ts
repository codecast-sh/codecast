import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { artifactView, specForCli } from "@codecast/shared/artifacts";
import { lifecycleGuide, parseDocRef, parseOpsInput, readNotes, refTitles, registerBoardCommand, registerDataCommand, registerSheetCommand, resolveRmKeys } from "./liveArtifactCommand";

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

describe("cast board frame verbs (pl-1145)", () => {
  const verbs = specForCli("board")!.verbs!;
  const sticky = (key: string, x: number, y: number, by = "s:agent") => ({ key, kind: "sticky", rev: 1, by, x, y, w: 200, h: 160, text: key }) as any;
  const frameEl = (key: string, x: number, y: number, w: number, h: number, extra: Record<string, any> = {}) => ({ key, kind: "frame", rev: 1, by: "s:agent", x, y, w, h, title: key, ...extra }) as any;
  const put = (r: { ops: any[] }, k: string) => r.ops.find((o) => o.k === k)?.put;
  const set = (r: { ops: any[] }, k: string) => r.ops.find((o) => o.k === k)?.set;

  test("place --frame-ref sets the frame's ref and titles it by the entity, falling back to the id", () => {
    const view = artifactView("board", "B", []);
    const titled = verbs.place.run(view, ["grid", "--frame-ref", "CT-12"], "One\nTwo", { titles: { "ct-12": "Budget caps" } });
    const f = titled.ops.find((o: any) => o.put?.kind === "frame") as any;
    expect(f.put).toMatchObject({ ref: "ct-12", title: "Budget caps" });
    expect(verbs.place.refs!(["grid", "--frame-ref", "ct-12"])).toEqual(["ct-12"]);
    const bare = verbs.place.run(view, ["grid", "--frame-ref", "pri-3"], "One");
    expect((bare.ops.find((o: any) => o.put?.kind === "frame") as any).put).toMatchObject({ ref: "pri-3", title: "pri-3" });
    expect(() => verbs.place.run(view, ["grid", "--frame-ref", "jx7abcd"], "One")).toThrow(/pri-N, in-N, pl-N or ct-N/);
  });

  test("frame --ref titles by the entity when the first word is a key, and --collapse folds it in the same batch", () => {
    const view = artifactView("board", "B", [sticky("el_a", 0, 0), sticky("el_b", 240, 0)]);
    const r = verbs.frame.run(view, ["el_a", "el_b", "--ref", "pl-9", "--status", "leaning", "--collapse"], undefined, { titles: { "pl-9": "Huddle board" } });
    // One put for the frame, already folded: no separate set op for it.
    const fk = r.ops.find((o: any) => o.put?.kind === "frame")!.k;
    expect(r.ops.filter((o) => o.k === fk)).toHaveLength(1);
    expect(put(r, fk)).toMatchObject({ ref: "pl-9", title: "Huddle board", status: "leaning", h: 48 });
    expect(put(r, fk).collapsed.holds.sort()).toEqual(["el_a", "el_b"]);
    expect(r.status).toMatch(/collapsed/);
    // A title given still wins over the entity.
    const own = verbs.frame.run(view, ["Mine", "el_a", "--ref", "pl-9"], undefined, { titles: { "pl-9": "Huddle board" } });
    expect((own.ops[0] as any).put).toMatchObject({ title: "Mine", ref: "pl-9" });
    expect(() => verbs.frame.run(view, ["T", "el_a", "--status", "maybe"])).toThrow(/open, leaning, decided, parked/);
  });

  test("edit --status tags a frame, --ref changes its entity and title, and both refuse a sticky", () => {
    const view = artifactView("board", "B", [frameEl("el_f", 0, 0, 400, 300), sticky("el_a", 40, 64)]);
    expect(set(verbs.edit.run(view, ["el_f", "--status", "decided"]), "el_f")).toEqual({ status: "decided" });
    expect(set(verbs.edit.run(view, ["el_f", "--status", "none"]), "el_f")).toEqual({ status: null });
    expect(set(verbs.edit.run(view, ["el_f", "--ref", "in-4"], undefined, { titles: { "in-4": "Grow teams" } }), "el_f")).toEqual({ ref: "in-4", title: "Grow teams" });
    expect(set(verbs.edit.run(view, ["el_f", "--ref", "none"]), "el_f")).toEqual({ ref: null });
    expect(() => verbs.edit.run(view, ["el_f", "--status", "done"])).toThrow(/--status is/);
    expect(() => verbs.edit.run(view, ["el_a", "--status", "open"])).toThrow(/frame's/);
  });

  test("collapse and expand fold a frame in one batch; the enclosing frame reflows", () => {
    const v0 = artifactView("board", "B", [frameEl("el_o", 0, 0, 1000, 800), frameEl("el_i", 40, 64, 500, 400), sticky("el_s1", 80, 128), sticky("el_s2", 700, 128)]);
    const r = verbs.collapse.run(v0, ["el_i"], undefined, { agent: true });
    expect(set(r, "el_i").collapsed.holds).toEqual(["el_s1"]);
    // The outer frame (only agent work in it) reflowed: s2 moved up beside the pill.
    expect(set(r, "el_s2")).toBeDefined();
    expect(r.status).toMatch(/^collapsed el_i \(1 held\)/);
    expect(r.status).not.toMatch(/left the enclosing frame/);
    const folded = artifactView("board", "B", [frameEl("el_f", 0, 0, 260, 48, { collapsed: { w: 400, h: 300, holds: ["el_a"] } }), sticky("el_a", 40, 64)]);
    const e = verbs.expand.run(folded, ["el_f"]);
    expect(set(e, "el_f")).toMatchObject({ collapsed: null, w: 400, h: 300 });
    expect(e.status).toMatch(/^expanded el_f \(1 shown\)/);
    expect(() => verbs.collapse.run(v0, ["el_s1"])).toThrow(/not a frame/);
  });

  test("an agent folding inside a frame that holds a person's sticky leaves that frame as it was, and says so", () => {
    const v0 = artifactView("board", "B", [frameEl("el_o", 0, 0, 1000, 800), frameEl("el_i", 40, 64, 500, 400), sticky("el_s1", 80, 128), sticky("el_s2", 700, 128, "u:jason")]);
    const r = verbs.collapse.run(v0, ["el_i"], undefined, { agent: true });
    expect(r.ops.map((o) => o.k)).toEqual(["el_i"]);
    expect(r.status!.split("\n")[1]).toBe("left the enclosing frame el_o as it was: it holds a person's work");
    // A person (no agent flag) gets the reflow.
    expect(verbs.collapse.run(v0, ["el_i"]).ops.map((o) => o.k)).toContain("el_s2");
  });

  test("reflow lays out one frame, or organizes the board with no frame; a laid-out frame writes nothing", () => {
    const v0 = artifactView("board", "B", [frameEl("el_f", 0, 0, 900, 700), sticky("el_a", 300, 300), sticky("el_b", 50, 100)]);
    const r = verbs.reflow.run(v0, ["el_f"]);
    expect(set(r, "el_f")).toBeDefined();
    expect(r.status).toMatch(/^reflowed el_f/);
    const after = artifactView("board", "B", v0.elements.map((e) => ({ ...e, ...set(r, e.key) })));
    expect(verbs.reflow.run(after, ["el_f"])).toEqual({ ops: [], status: "el_f is already laid out" });
    const org = verbs.reflow.run(artifactView("board", "B", [frameEl("el_f", 0, 0, 400, 300), frameEl("el_g", 2000, 900, 400, 300)]), []);
    expect(org.ops.length).toBeGreaterThan(0);
    expect(org.status).toMatch(/^organized the board/);
    expect(() => verbs.reflow.run(v0, ["el_a"])).toThrow(/not a frame/);
  });

  test("move on a frame carries what it holds; on a folded pill, its hidden holds travel too", () => {
    const v0 = artifactView("board", "B", [frameEl("el_f", 0, 0, 400, 300), sticky("el_a", 40, 64), sticky("el_out", 600, 0)]);
    const r = verbs.move.run(v0, ["el_f", "--by", "100,50"]);
    expect(r.ops.map((o) => o.k).sort()).toEqual(["el_a", "el_f"]);
    expect(set(r, "el_a")).toEqual({ x: 140, y: 114 });
    const pill = artifactView("board", "B", [frameEl("el_p", 0, 0, 260, 48, { collapsed: { w: 400, h: 300, holds: ["el_h"] } }), sticky("el_h", 40, 64)]);
    expect(set(verbs.move.run(pill, ["el_p", "--to", "500,500"]), "el_h")).toEqual({ x: 540, y: 564 });
  });
});

describe("refTitles", () => {
  test("reads each id's title from its own route once, and leaves out one that can't be read", async () => {
    const calls: string[] = [];
    const answers: Record<string, any> = {
      "/cli/work/get": { title: "Fix the auth race" },
      "/cli/plans/get": { title: "Huddle board Scribe" },
      "/cli/priorities/show": { title: " Budget caps " },
      "/cli/initiatives/get": null,
    };
    const post = async (path: string, body: Record<string, any>) => {
      calls.push(`${path} ${JSON.stringify(body)}`);
      if (!(path in answers)) throw new Error(`unplanned ${path}`);
      return answers[path];
    };
    expect(await refTitles(post, ["ct-1", "pl-2", "pri-3", "in-4", "ct-1"])).toEqual({ "ct-1": "Fix the auth race", "pl-2": "Huddle board Scribe", "pri-3": "Budget caps" });
    expect(calls).toEqual([
      '/cli/work/get {"short_id":"ct-1"}',
      '/cli/plans/get {"short_id":"pl-2"}',
      '/cli/priorities/show {"short_id":"pri-3"}',
      '/cli/initiatives/get {"id":"in-4"}',
    ]);
    const refused = async () => { throw new Error("not found"); };
    expect(await refTitles(refused, ["ct-9"])).toEqual({});
  });
});

describe("cast board frame verbs through the CLI", () => {
  test("frame --ref --collapse reads the title, writes one batch as the session, and courtesy reaches the verb", async () => {
    const seen: { path: string; body: any }[] = [];
    const elements = [
      { key: "el_o", kind: "frame", rev: 1, by: "u:jason", at: 1, fields: { x: 0, y: 0, w: 1000, h: 800, title: "Jason's", z: 0 } },
      { key: "el_a", kind: "sticky", rev: 1, by: "s:x", at: 1, fields: { x: 80, y: 128, w: 200, h: 160, text: "a", z: 1 } },
      { key: "el_p", kind: "sticky", rev: 1, by: "u:jason", at: 1, fields: { x: 700, y: 128, w: 200, h: 160, text: "mine", z: 2 } },
    ];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = await req.json();
        seen.push({ path, body: structuredClone(body) });
        if (path === "/cli/live/elements") return Response.json({ title: "B", doc_type: "board", head: 3, rows: elements.map((e) => ({ ...e, layer: "main" })), more: false });
        if (path === "/cli/work/get") return Response.json(body.short_id === "ct-12" ? { title: "Budget caps" } : { error: `no task ${body.short_id} you can see` });
        if (path === "/cli/live/apply") return Response.json({ rev: 4, keys: body.ops.map((o: any) => o.k) });
        return new Response("unplanned", { status: 500 });
      },
    });
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: any[]) => { logs.push(a.join(" ")); };
    try {
      const p = new Command();
      registerBoardCommand(p, { getCliEndpoint: () => ({ siteUrl: `http://127.0.0.1:${server.port}`, apiToken: "t" }), detectCurrentSessionId: () => "sess1" } as any);
      await p.parseAsync(["node", "cast", "board", "frame", ID, "el_a", "--ref", "ct-12", "--collapse"]);
      // A task the caller can't read titles the frame by its id instead of stopping the write.
      const q = new Command();
      registerBoardCommand(q, { getCliEndpoint: () => ({ siteUrl: `http://127.0.0.1:${server.port}`, apiToken: "t" }), detectCurrentSessionId: () => "sess1" } as any);
      await q.parseAsync(["node", "cast", "board", "frame", ID, "el_a", "--ref", "ct-13"]);
    } finally {
      console.log = log;
      server.stop(true);
    }
    expect(seen.map((s) => s.path)).toEqual(["/cli/live/elements", "/cli/work/get", "/cli/live/apply", "/cli/live/elements", "/cli/work/get", "/cli/live/apply"]);
    expect(seen[5].body.ops[0].put).toMatchObject({ kind: "frame", ref: "ct-13", title: "ct-13" });
    const apply = seen[2].body;
    expect(apply.session_id).toBe("sess1");
    // One op: the new frame, folded; the person's enclosing frame and sticky are left alone.
    expect(apply.ops).toHaveLength(1);
    expect(apply.ops[0].put).toMatchObject({ kind: "frame", ref: "ct-12", title: "Budget caps", collapsed: { holds: ["el_a"] } });
    expect(logs.join("\n")).toContain("left the enclosing frame el_o as it was: it holds a person's work");
  });
});
