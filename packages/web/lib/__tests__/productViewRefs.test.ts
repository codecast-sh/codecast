import { describe, expect, test } from "bun:test";
import { appSlug, momentViewRef, readViewFence, viewRefFromPayload, viewRefScanRegex } from "../productViewRefs";
import { remarkEntityIds } from "../remarkEntityIds";

const CONTACT = "2b7c1d5e-9f3a-4c61-8e2d-0a1b2c3d4e5f";

describe("the view fence", () => {
  test("reads source, view, id and at into a reference, with its fallbacks", () => {
    const read = readViewFence(JSON.stringify({ source: "union", view: "conversation", id: CONTACT, at: "2026-10-09T14:03:00Z", moment: "mo-12" }));
    expect(read).toEqual({ ok: true, spec: { ref: { app: "union", view: "conversation", id: CONTACT, at: "2026-10-09T14:03:00Z" }, moment: "mo-12", url: null, title: null } });
    const linked = readViewFence(JSON.stringify({ source: "Union", view: "call", id: "c1234567", url: "https://admin.union.example/calls/c1", title: "The call" }));
    expect(linked).toMatchObject({ ok: true, spec: { ref: { app: "union", view: "call", at: null }, url: "https://admin.union.example/calls/c1", title: "The call" } });
  });

  test("says why a spec cannot be one, so the block stays code", () => {
    expect(readViewFence("not json")).toEqual({ ok: false, why: "The block is not JSON." });
    expect(readViewFence("[]")).toMatchObject({ ok: false });
    expect(readViewFence(JSON.stringify({ source: "union", view: "conversation" }))).toMatchObject({ ok: false, why: "A view needs a source, a view and an id." });
    expect(readViewFence(JSON.stringify({ source: "union", view: "conversation", id: CONTACT, at: "yesterday" }))).toMatchObject({ ok: false });
    expect(readViewFence(JSON.stringify({ source: "union", view: "conversation", id: "a b/c" }))).toMatchObject({ ok: false });
    // A link that is not http(s) is dropped, never followed.
    expect(readViewFence(JSON.stringify({ source: "union", view: "call", id: "c1234567", url: "javascript:alert(1)" }))).toMatchObject({ ok: true, spec: { url: null } });
  });
});

describe("references in prose", () => {
  const scan = (t: string) => t.match(viewRefScanRegex()) ?? [];

  test("finds a reference with or without its moment", () => {
    expect(scan(`see union:conversation/${CONTACT}@2026-10-09T14:03:00Z.`)).toEqual([`union:conversation/${CONTACT}@2026-10-09T14:03:00Z`]);
    expect(scan(`(union:call/${CONTACT}) and union:match/m0000001`)).toEqual([`union:call/${CONTACT}`, "union:match/m0000001"]);
  });

  test("leaves urls, paths and look-alikes as prose", () => {
    expect(scan("github:ashot/codecast")).toEqual([]);
    expect(scan("note:a/b12")).toEqual([]);
    expect(scan(`https://x.example/union:conversation/${CONTACT}`)).toEqual([]);
    expect(scan(`localhost:3201/line?x=${CONTACT}`)).toEqual([]);
    expect(scan(`src/union:conversation/${CONTACT}/more`)).toEqual([]);
  });

  test("a payload reads back only when it is a reference", () => {
    expect(viewRefFromPayload(`view:union:call/${CONTACT}`)).toEqual({ app: "union", view: "call", id: CONTACT, at: null });
    expect(viewRefFromPayload("view: the details")).toBeNull();
    expect(viewRefFromPayload("doc:abc")).toBeNull();
  });

  const para = (text: string) => ({ type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] });

  test("alone on its line it is hoisted to an embed; in a sentence it is a pill", () => {
    const alone: any = para(`union:conversation/${CONTACT}`);
    remarkEntityIds()(alone);
    expect(alone.children).toHaveLength(1);
    expect(alone.children[0]).toMatchObject({ type: "link", children: [{ value: `embed:view:union:conversation/${CONTACT}` }] });

    const inline: any = para(`Kerri's thread union:conversation/${CONTACT} shows it.`);
    remarkEntityIds()(inline);
    const p = inline.children[0];
    expect(p.type).toBe("paragraph");
    const link = p.children.find((c: any) => c.type === "link");
    expect(link).toMatchObject({ url: `entity://view:union:conversation/${CONTACT}`, children: [{ value: `view:union:conversation/${CONTACT}` }] });
    // The path scan never split it into a file link.
    expect(p.children.filter((c: any) => c.type === "link")).toHaveLength(1);
  });
});

describe("a moment's view", () => {
  test("is its subject in the app named by its source, as of the moment", () => {
    expect(momentViewRef({ source: "union", kind: "contact-conversation", subject: CONTACT, at: Date.parse("2026-10-09T14:03:00Z") })).toEqual({
      app: "union", view: "conversation", id: CONTACT, at: "2026-10-09T14:03:00.000Z",
    });
    expect(momentViewRef({ source: "Union Moments", kind: "call", subject: CONTACT, at: null })).toMatchObject({ app: "union-moments", view: "call", at: null });
    expect(momentViewRef({ source: null, kind: "call", subject: CONTACT, at: null })).toBeNull();
    expect(momentViewRef({ source: "union", kind: "call", subject: "has space", at: null })).toBeNull();
  });

  test("appSlug matches the server's rule", () => {
    expect(appSlug("  Union prod ")).toBe("union-prod");
    expect(appSlug("AgentWatch (judge)")).toBe("agentwatch-judge");
  });
});
