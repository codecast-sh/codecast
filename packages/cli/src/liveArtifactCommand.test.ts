import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { artifactView, board, specForCli } from "@codecast/shared/artifacts";
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

describe("cast board frame verbs (pl-1145)", () => {
  const verbs = specForCli("board")!.verbs!;
  const sticky = (key: string, x: number, y: number, by = "s:agent") => ({ key, kind: "sticky", rev: 1, by, x, y, w: 200, h: 160, text: key }) as any;
  const frameEl = (key: string, x: number, y: number, w: number, h: number, extra: Record<string, any> = {}) => ({ key, kind: "frame", rev: 1, by: "s:agent", x, y, w, h, title: key, ...extra }) as any;
  const put = (r: { ops: any[] }, k: string) => r.ops.find((o) => o.k === k)?.put;
  const set = (r: { ops: any[] }, k: string) => r.ops.find((o) => o.k === k)?.set;
  /** One batch applied the way live.apply does, `by` kept. */
  const apply = (v: any, ops: any[]) => artifactView("board", "B", v.elements.flatMap((e: any) => {
    const o = ops.find((x) => x.k === e.key);
    if (o && "del" in o) return [];
    const r = { ...e, ...(o?.set ?? {}) };
    for (const k in o?.set ?? {}) if (o.set[k] === null) delete r[k];
    return [r];
  }).concat(ops.filter((o) => "put" in o && !v.get(o.k)).map((o) => ({ ...o.put, key: o.k, rev: 0 }))));
  const AGENT = { agent: true };

  test("place --frame-ref writes the ref and titles the frame with the caller's words or the bare id, never a looked-up title", () => {
    const view = artifactView("board", "B", []);
    const bare = verbs.place.run(view, ["grid", "--frame-ref", "CT-12"], "One\nTwo");
    expect((bare.ops.find((o: any) => o.put?.kind === "frame") as any).put).toMatchObject({ ref: "ct-12", title: "ct-12" });
    const named = verbs.place.run(view, ["grid", "--frame-ref", "pri-3", "--frame", "Budget caps"], "One");
    expect((named.ops.find((o: any) => o.put?.kind === "frame") as any).put).toMatchObject({ ref: "pri-3", title: "Budget caps" });
    expect(() => verbs.place.run(view, ["grid", "--frame-ref", "jx7abcd"], "One")).toThrow(/pri-N, in-N, pl-N or ct-N/);
  });

  test("frame --ref with keys only is titled by the id, refuses a mistyped key, and --collapse folds it in the same batch", () => {
    const view = artifactView("board", "B", [sticky("el_a", 0, 0), sticky("el_b", 240, 0)]);
    const r = verbs.frame.run(view, ["el_a", "el_b", "--ref", "pl-9", "--collapse"], undefined, AGENT);
    const fk = r.ops.find((o: any) => o.put?.kind === "frame")!.k;
    // One put for the frame, already folded: no separate set op for it.
    expect(r.ops.filter((o) => o.k === fk)).toHaveLength(1);
    expect(put(r, fk)).toMatchObject({ ref: "pl-9", title: "pl-9", h: 48 });
    expect(put(r, fk).collapsed.holds.sort()).toEqual(["el_a", "el_b"]);
    expect((verbs.frame.run(view, ["Mine", "el_a", "--ref", "pl-9"]).ops[0] as any).put).toMatchObject({ title: "Mine", ref: "pl-9" });
    expect(() => verbs.frame.run(view, ["el_typo", "el_a", "--ref", "ct-1"])).toThrow("no element el_typo on this board");
  });

  test("edit --ref writes only what changes and keep the title unless new words are given", () => {
    const view = artifactView("board", "B", [frameEl("el_f", 0, 0, 400, 300, { title: "Budget caps", ref: "ct-1" }), frameEl("el_g", 0, 400, 400, 300, { title: "" }), sticky("el_a", 40, 64)]);
    expect(set(verbs.edit.run(view, ["el_f", "--ref", "in-4"]), "el_f")).toEqual({ ref: "in-4" });
    expect(set(verbs.edit.run(view, ["el_f", "New", "words", "--ref", "in-4"]), "el_f")).toEqual({ title: "New words", ref: "in-4" });
    expect(set(verbs.edit.run(view, ["el_g", "--ref", "in-4"]), "el_g")).toEqual({ ref: "in-4", title: "in-4" });
    expect(set(verbs.edit.run(view, ["el_f", "--ref", "none"]), "el_f")).toEqual({ ref: null });
    expect(verbs.edit.run(view, ["el_f", "--ref", "ct-1"])).toEqual({ ops: [], status: "el_f already has that ref: nothing to write" });
    expect(() => verbs.edit.run(view, ["el_a", "--ref", "ct-1"])).toThrow(/--ref is a frame's/);
  });

  test("collapse and expand fold a frame in one batch; with no person's work about, the enclosing frame reflows", () => {
    const v0 = artifactView("board", "B", [frameEl("el_o", 0, 0, 1000, 800), frameEl("el_i", 40, 64, 500, 400), sticky("el_s1", 80, 128), sticky("el_s2", 700, 128)]);
    const r = verbs.collapse.run(v0, ["el_i"], undefined, AGENT);
    expect(set(r, "el_i").collapsed.holds).toEqual(["el_s1"]);
    expect(set(r, "el_s2")).toBeDefined();
    expect(r.status).toBe("collapsed el_i (1 held)\nkeys: el_i");
    const folded = artifactView("board", "B", [frameEl("el_f", 0, 0, 260, 48, { collapsed: { w: 400, h: 300, holds: ["el_a"] } }), sticky("el_a", 40, 64)]);
    const e = verbs.expand.run(folded, ["el_f"], undefined, AGENT);
    expect(set(e, "el_f")).toMatchObject({ collapsed: null, w: 400, h: 300 });
    expect(e.status).toMatch(/^expanded el_f \(1 shown\)/);
    expect(() => verbs.collapse.run(v0, ["el_s1"])).toThrow(/not a frame/);
  });

  test("courtesy: an agent's expand that would swallow a person's sticky is refused; a person's own run goes ahead", () => {
    // A person folded the notes and the theme shrank around the pill, their sticky beside it.
    const v0 = artifactView("board", "B", [frameEl("el_t", 0, 0, 1200, 900), frameEl("el_n", 40, 64, 500, 400), sticky("el_s", 80, 128), sticky("el_p", 640, 64, "u:jason")]);
    const v1 = apply(v0, verbs.collapse.run(v0, ["el_n"]).ops);
    expect(v1.get("el_p")).toMatchObject({ x: 324, y: 64 });
    expect(() => verbs.expand.run(v1, ["el_n"], undefined, AGENT)).toThrow("left the board as it was: this would move or enclose a person's work (el_p). A person can press Reflow or Organize on the board.");
    expect(verbs.expand.run(v1, ["el_n"]).ops.length).toBeGreaterThan(0);
    // At the top level an expand that pushes a person's sticky down is refused the same way.
    const top = artifactView("board", "B", [frameEl("el_n", 0, 0, 260, 48, { collapsed: { w: 500, h: 400, holds: ["el_s"] } }), sticky("el_s", 40, 64), sticky("el_p", 0, 200, "u:jason")]);
    expect(() => verbs.expand.run(top, ["el_n"], undefined, AGENT)).toThrow(/\(el_p\)/);
    expect(set(verbs.expand.run(top, ["el_n"]), "el_p")).toEqual({ y: 424 });
  });

  test("courtesy: an agent's collapse reflows the levels below the one holding a person's work and names that level", () => {
    const v0 = artifactView("board", "B", [
      frameEl("el_o", 0, 0, 2000, 1200, { title: "Budget" }),
      frameEl("el_t", 40, 64, 900, 900),
      frameEl("el_n", 80, 128, 500, 400),
      sticky("el_s", 120, 192),
      frameEl("el_sib", 1000, 64, 900, 900),
      sticky("el_p", 1040, 128, "u:jason"),
    ]);
    const r = verbs.collapse.run(v0, ["el_n"], undefined, AGENT);
    expect(r.ops.map((o) => o.k).sort()).toEqual(["el_n", "el_t"]);
    expect(r.status!.split("\n")[1]).toBe(`left "Budget" as it was: it holds a person's work`);
    // A person's collapse reflows every level, moving el_sib and el_p.
    expect(verbs.collapse.run(v0, ["el_n"]).ops.map((o) => o.k)).toEqual(expect.arrayContaining(["el_o", "el_sib", "el_p"]));
  });

  test("courtesy: an agent's reflow, organize and frame move that would touch a person's sticky are refused; a person's are not", () => {
    const v0 = artifactView("board", "B", [frameEl("el_t", 0, 0, 1200, 900), sticky("el_p", 700, 500, "u:jason"), sticky("el_s", 80, 128)]);
    for (const args of [["el_t"], []]) {
      expect(() => verbs.reflow.run(v0, args, undefined, AGENT)).toThrow(/a person's work \(el_p\)/);
      expect(set(verbs.reflow.run(v0, args), "el_p")).toEqual({ x: 264, y: 64 });
    }
    expect(() => verbs.move.run(v0, ["el_t", "--by", "100,0"], undefined, AGENT)).toThrow(/\(el_p\)/);
    expect(set(verbs.move.run(v0, ["el_t", "--by", "100,0"]), "el_p")).toEqual({ x: 800, y: 500 });
    // Moving an agent's own frame of agent work is fine; so is reflowing one.
    const own = artifactView("board", "B", [frameEl("el_t", 0, 0, 1200, 900), sticky("el_s", 80, 128), sticky("el_p", 2000, 0, "u:jason")]);
    expect(verbs.move.run(own, ["el_t", "--by", "100,0"], undefined, AGENT).ops.map((o) => o.k).sort()).toEqual(["el_s", "el_t"]);
    expect(verbs.reflow.run(own, ["el_t"], undefined, AGENT).ops.length).toBeGreaterThan(0);
  });

  test("reflow lays out one frame, or organizes the board with no frame; a laid-out frame writes nothing", () => {
    const v0 = artifactView("board", "B", [frameEl("el_f", 0, 0, 900, 700), sticky("el_a", 300, 300), sticky("el_b", 50, 100)]);
    const r = verbs.reflow.run(v0, ["el_f"]);
    expect(r.status).toMatch(/^reflowed el_f/);
    expect(verbs.reflow.run(apply(v0, r.ops), ["el_f"])).toEqual({ ops: [], status: "el_f is already laid out" });
    const org = verbs.reflow.run(artifactView("board", "B", [frameEl("el_f", 0, 0, 400, 300), frameEl("el_g", 2000, 900, 400, 300)]), []);
    expect(org.status).toMatch(/^organized the board/);
    expect(() => verbs.reflow.run(v0, ["el_a"])).toThrow(/not a frame/);
  });

  test("Scribe's fold: notes framed around all of a theme's stickies sit strictly inside it, and the fold holds only the stickies", () => {
    // place --frame-ref draws the theme around 3 stickies.
    const placed = verbs.place.run(artifactView("board", "B", []), ["grid", "--frame-ref", "ct-5"], "Budget caps\nAlert at 80%\nQuarterly review");
    const v1 = apply(artifactView("board", "B", []), placed.ops);
    const theme = placed.ops.find((o: any) => o.put?.kind === "frame")!.k;
    const stickies = placed.ops.filter((o: any) => o.put?.kind === "sticky").map((o) => o.k);
    // Working notes around all three, folded at once.
    const framed = verbs.frame.run(v1, ["Working notes", ...stickies, "--collapse"], undefined, AGENT);
    const notes = framed.ops.find((o: any) => o.put?.kind === "frame")!.k;
    const inner = put(framed, notes), outer = v1.get(theme)!;
    expect(inner.collapsed.w * inner.collapsed.h).toBeLessThan(Number(outer.w) * Number(outer.h));
    const v2 = apply(v1, framed.ops);
    expect(inner.collapsed.holds.sort()).toEqual([...stickies].sort());
    expect([...board.hiddenKeys(v2)].sort()).toEqual([...stickies].sort());
    expect(board.enclosingFrameKeys(v2, notes)).toEqual([theme]);
    // A card filed into the theme makes it resolved: it narrows to the card and the pill stacks under it.
    const tb = board.elementBox(v2.get(theme)!);
    const v3 = apply(v2, [{ k: theme, set: { h: tb.h + 400 } }, { k: "el_card", put: { kind: "card", ref: "ct-5", x: tb.x + 40, y: tb.y + 140, w: 320, h: 168, z: 5 } }]);
    const v4 = apply(v3, verbs.reflow.run(v3, [theme], undefined, AGENT).ops);
    const pill = board.elementBox(v4.get(notes)!), card = board.elementBox(v4.get("el_card")!), t4 = board.elementBox(v4.get(theme)!);
    expect(t4.w).toBe(Math.max(320, pill.w) + 2 * board.FRAME_PAD);
    expect([card.x, pill.x]).toEqual([t4.x + board.FRAME_PAD, t4.x + board.FRAME_PAD]);
    expect(board.hiddenKeys(v4).has(theme)).toBe(false);
  });

  test("Scribe's resolve: fold the notes, add the summary, card --at inside the theme, reflow: the resolved shape, nothing overlapping", () => {
    const placed = verbs.place.run(artifactView("board", "B", []), ["grid", "--frame-ref", "ct-5", "--at", "0,0"], "Budget caps\nAlert at 80%\nQuarterly review");
    let v = apply(artifactView("board", "B", [sticky("el_below", 0, 600)]), placed.ops);
    const theme = placed.ops.find((o: any) => o.put?.kind === "frame")!.k;
    const stickies = placed.ops.filter((o: any) => o.put?.kind === "sticky").map((o) => o.k);
    const folded = verbs.frame.run(v, ["Working notes", ...stickies, "--collapse"], undefined, AGENT);
    const notes = folded.ops.find((o: any) => o.put?.kind === "frame")!.k;
    v = apply(v, folded.ops);
    const summary = verbs.add.run(v, ["text:16", "**To summarize:** cap each team's monthly spend and alert at eighty percent", "--at", "40,64"], undefined, AGENT);
    const sumKey = summary.ops.find((o: any) => o.put?.kind === "text")!.k;
    v = apply(v, summary.ops);
    // The card runs past the folded theme's bottom edge: the theme grows to hold it, in the same batch, and pushes what it now covers.
    const placedCard = verbs.card.run(v, ["ct-5", "--at", "40,120"], undefined, AGENT);
    const cardKey = placedCard.ops.find((o: any) => o.put?.kind === "card")!.k;
    expect(placedCard.ops.map((o) => o.k)).toContain(theme);
    expect(placedCard.status).toMatch(/grew "ct-5" to hold it/);
    v = apply(v, placedCard.ops);
    const tb = board.elementBox(v.get(theme)!), cb = board.elementBox(v.get(cardKey)!);
    expect(cb.y + cb.h + board.FRAME_PAD).toBeLessThanOrEqual(tb.y + tb.h);
    expect(board.elementBox(v.get("el_below")!).y).toBeGreaterThanOrEqual(tb.y + tb.h);
    expect(board.enclosingFrameKeys(v, cardKey)).toEqual([theme]);
    // Reflow: narrow to the card, summary then card then pill, nothing overlapping.
    v = apply(v, verbs.reflow.run(v, [theme], undefined, AGENT).ops);
    const t = board.elementBox(v.get(theme)!), sum = board.elementBox(v.get(sumKey)!), card = board.elementBox(v.get(cardKey)!), pill = board.elementBox(v.get(notes)!);
    expect(t.w).toBe(Math.max(320, pill.w) + 2 * board.FRAME_PAD);
    expect(sum.w).toBe(t.w - 2 * board.FRAME_PAD);
    expect(sum.y + sum.h).toBeLessThanOrEqual(card.y);
    expect(card.y + card.h).toBeLessThanOrEqual(pill.y);
    for (const b of [sum, card, pill]) expect(board.contains(t, b)).toBe(true);
    expect(verbs.reflow.run(v, [theme]).ops).toEqual([]);
    expect([...board.hiddenKeys(v)].sort()).toEqual([...stickies].sort());
  });

  test("a card --at a point outside every frame is placed alone", () => {
    const v = artifactView("board", "B", [frameEl("el_f", 0, 0, 400, 300)]);
    const r = verbs.card.run(v, ["ct-5", "--at", "600,0"]);
    expect(r.ops).toHaveLength(1);
    expect(r.status).not.toMatch(/grew/);
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

describe("cast board frame verbs through the CLI", () => {
  test("frame --ref --collapse reads the board, writes one batch as the session, and courtesy reaches the verb", async () => {
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
    } finally {
      console.log = log;
      server.stop(true);
    }
    expect(seen.map((s) => s.path)).toEqual(["/cli/live/elements", "/cli/live/apply"]);
    const apply = seen[1].body;
    expect(apply.session_id).toBe("sess1");
    // One op: the new frame, folded; the person's enclosing frame and sticky are left alone.
    expect(apply.ops).toHaveLength(1);
    expect(apply.ops[0].put).toMatchObject({ kind: "frame", ref: "ct-12", title: "ct-12", collapsed: { holds: ["el_a"] } });
    expect(logs.join("\n")).toContain(`left "Jason's" as it was: it holds a person's work`);
  });
});
