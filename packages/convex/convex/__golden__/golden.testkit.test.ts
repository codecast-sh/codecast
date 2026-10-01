import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callModel } from "../lib/anthropic";
import { captureFetch, loadGolden, recordGolden, type GoldenCase } from "./golden.testkit";

const A: GoldenCase = { case: "a", body: "body a" };
const B: GoldenCase = { case: "b", body: "body b" };

// Each block pins UPDATE_GOLDENS for its own tests and puts the caller's value
// back, so the file passes whether or not the run itself re-records goldens.
function pinUpdateGoldens(value: "1" | undefined) {
  const caller = process.env.UPDATE_GOLDENS;
  const put = (v: string | undefined) => {
    if (v === undefined) delete process.env.UPDATE_GOLDENS;
    else process.env.UPDATE_GOLDENS = v;
  };
  beforeEach(() => put(value));
  afterEach(() => put(caller));
}

describe("golden testkit under UPDATE_GOLDENS=1", () => {
  let dir: string;
  const file = () => join(dir, "g.json");
  pinUpdateGoldens("1");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "golden-"));
    writeFileSync(file(), `${JSON.stringify([A, B], null, 2)}\n`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a test that only reads a golden leaves it on disk as recorded", () => {
    const before = readFileSync(file(), "utf8");
    expect(loadGolden("g", dir)).toEqual([A, B]);
    expect(recordGolden("g", [], dir)).toEqual([]);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  test("two tests recording one golden keep each other's cases", () => {
    const a2 = { case: "a", body: "body a, re-recorded" };
    const c = { case: "c", body: "body c" };
    expect(recordGolden("g", [a2], dir)).toEqual([a2]);
    expect(recordGolden("g", [c], dir)).toEqual([c]);
    expect(loadGolden("g", dir)).toEqual([a2, B, c]);
  });
});

describe("golden testkit when comparing", () => {
  pinUpdateGoldens(undefined);
  test("a case the golden lacks fails the comparison with the fix named", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    try {
      writeFileSync(join(dir, "g.json"), JSON.stringify([A]));
      const actual = [B, A];
      const recorded = recordGolden("g", actual, dir);
      expect(recorded[1]).toEqual(A);
      expect(recorded[0]!.body).toContain("UPDATE_GOLDENS=1");
      expect(recorded).not.toEqual(actual);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureFetch", () => {
  test("its reply reaches callModel, which keeps only text blocks", async () => {
    const stub = captureFetch("the stubbed reply");
    stub.install();
    try {
      const reply = await callModel({ prompt: "say it", max_tokens: 10, label: "stub test" });
      expect(reply?.text).toBe("the stubbed reply");
      expect(stub.bodies).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });
});
