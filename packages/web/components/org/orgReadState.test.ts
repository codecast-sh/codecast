import { describe, expect, test } from "bun:test";
import { orgTreeReadState, readableReadError } from "./orgReadState";

const base = { hasTree: false, hasNodes: false, ready: false, missing: false, refused: false, error: null };

describe("what the canvas says about the tree read", () => {
  test("a failed read is an error, never an empty chart or an endless skeleton", () => {
    const limit = new Error("[CONVEX Q(org:tree)] [Request ID: abc] Server Error\nUncaught Error: Too many documents read in a single function execution (limit: 32000)\n    at handler");
    expect(orgTreeReadState({ ...base, error: limit })).toEqual({ kind: "error", message: "Too many documents read in a single function execution (limit: 32000)" });
    // The same failure over a cached tree paints the cache and says so.
    expect(orgTreeReadState({ ...base, hasTree: true, hasNodes: true, error: limit }).kind).toBe("stale");
    // A cached tree with nobody in it is not worth calling stale.
    expect(orgTreeReadState({ ...base, hasTree: true, hasNodes: false, error: limit }).kind).toBe("error");
  });

  test("a refusal is said as a refusal", () => {
    expect(orgTreeReadState({ ...base, ready: true, refused: true })).toEqual({ kind: "refused" });
    // A cached tree from before the refusal still paints.
    expect(orgTreeReadState({ ...base, ready: true, refused: true, hasTree: true, hasNodes: true }).kind).toBe("ok");
  });

  test("not deployed, loading, empty and ok keep their meanings", () => {
    const notDeployed = new Error("Could not find public function for 'org:tree'");
    expect(orgTreeReadState({ ...base, missing: true, error: notDeployed }).kind).toBe("missing");
    expect(orgTreeReadState(base).kind).toBe("loading");
    expect(orgTreeReadState({ ...base, ready: true, hasTree: true }).kind).toBe("empty");
    expect(orgTreeReadState({ ...base, ready: true, hasTree: true, hasNodes: true }).kind).toBe("ok");
    // Painting from cache before the first answer is ok, not loading.
    expect(orgTreeReadState({ ...base, hasTree: true, hasNodes: true }).kind).toBe("ok");
  });

  test("the message is the server's sentence, short", () => {
    expect(readableReadError(undefined)).toBe("the server did not say why");
    expect(readableReadError("Forbidden")).toBe("Forbidden");
    expect(readableReadError("x".repeat(400)).length).toBe(198);
  });
});
