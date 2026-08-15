// The index is the only record that an account exists — nothing in the CLI
// rebuilds it by enumerating the keychain or the profile directories. Every
// caller reads it, changes one profile, and writes the whole thing back, so the
// only question worth testing is which read failures are allowed to reach that
// write. "Absent" may; nothing else may.

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJsonForUpdate, readProfileIndexFile } from "./readForUpdate.js";
import { readProviderKeyStore, readProviderKeyStoreForUpdate } from "./providerKeyStore.js";

class TestError extends Error {}
const wrap = (m: string) => new TestError(m);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-index-"));
let n = 0;
function fixture(body?: string, mode?: number): string {
  const p = path.join(root, `index-${n++}.json`);
  if (body !== undefined) fs.writeFileSync(p, body);
  if (mode !== undefined) fs.chmodSync(p, mode);
  return p;
}

const TWO = { profiles: { work: { email: "a@x.com" }, personal: { email: "b@x.com" } } };

describe("readProfileIndexFile", () => {
  it("returns the profiles a healthy index holds", () => {
    const got = readProfileIndexFile(fixture(JSON.stringify(TWO)), wrap);
    expect(Object.keys(got.profiles)).toEqual(["work", "personal"]);
  });

  it("treats an absent file as an empty index — nobody has saved a profile yet", () => {
    expect(readProfileIndexFile(path.join(root, "never-written.json"), wrap)).toEqual({
      profiles: {},
    });
  });

  it("treats a zero-byte file as empty, since there is nothing left to preserve", () => {
    expect(readProfileIndexFile(fixture(""), wrap).profiles).toEqual({});
  });

  it("throws the caller's error class, not a bare Error", () => {
    // Callers print these as account errors; a raw Error would escape as a crash.
    expect(() => readProfileIndexFile(fixture("{ truncated"), wrap)).toThrow(TestError);
  });

  it("refuses a truncated index instead of reporting zero accounts", () => {
    const body = JSON.stringify(TWO).slice(0, 25);
    const p = fixture(body);
    expect(() => readProfileIndexFile(p, wrap)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(p, "utf-8")).toBe(body);
  });

  it("refuses an index it cannot read instead of reporting zero accounts", () => {
    if (process.getuid?.() === 0) return; // root reads through any mode
    const p = fixture(JSON.stringify(TWO), 0o000);
    expect(() => readProfileIndexFile(p, wrap)).toThrow(/cannot be read \(EACCES\)/);
    fs.chmodSync(p, 0o600);
    expect(readProfileIndexFile(p, wrap).profiles).toEqual(TWO.profiles);
  });

  it("refuses JSON that parses but is not an index", () => {
    // Each of these would have satisfied a `parsed && typeof parsed === "object"`
    // check somewhere, and each would have yielded an undefined `.profiles` that
    // a caller then writes back as a wiped index.
    for (const body of ["null", "[]", '"a string"', "42", "{}", '{"profiles": null}']) {
      expect(() => readProfileIndexFile(fixture(body), wrap), body).toThrow(TestError);
    }
  });

  it("says which file, what it refused, and what to do — in every refusal", () => {
    const cases = [fixture("{ truncated"), fixture("[]")];
    if (process.getuid?.() !== 0) cases.push(fixture("{}", 0o000));

    for (const p of cases) {
      let message = "";
      try {
        readProfileIndexFile(p, wrap);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, p).toContain(p); // which file
      expect(message, p).toMatch(/refusing to continue/); // what did not happen
      expect(message, p).toMatch(/re-run the command/); // what to do next
    }
  });
});

// The provider key store shares the guard but NOT the policy: a launch must
// survive a broken file, and only the update path may refuse.
describe("provider key store: the split between reading and updating", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  const write = (body: string, mode = 0o600) => {
    const p = path.join(dir, "provider-keys.json");
    fs.writeFileSync(p, body);
    fs.chmodSync(p, mode);
    return p;
  };

  it("reads a healthy store the same way through both doors", () => {
    write(JSON.stringify({ openai: "sk-1", anthropic: "sk-2" }));
    expect(readProviderKeyStore(dir)).toEqual({ openai: "sk-1", anthropic: "sk-2" });
    expect(readProviderKeyStoreForUpdate(dir)).toEqual({ openai: "sk-1", anthropic: "sk-2" });
  });

  it("a launch still starts on a corrupt store; an update refuses to overwrite it", () => {
    write("{ truncated");
    // Breaking a launch over this file would be worse than using system auth.
    expect(readProviderKeyStore(dir)).toEqual({});
    // But `cast keys set` writing {} back would delete every other key.
    expect(() => readProviderKeyStoreForUpdate(dir)).toThrow(/not valid JSON/);
  });

  it("an absent store is empty on both paths — that is the documented default", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pk-empty-"));
    expect(readProviderKeyStore(empty)).toEqual({});
    expect(readProviderKeyStoreForUpdate(empty)).toEqual({});
  });

  it("refuses an unreadable store on the update path only", () => {
    if (process.getuid?.() === 0) return;
    const p = write(JSON.stringify({ openai: "sk-1" }), 0o000);
    expect(readProviderKeyStore(dir)).toEqual({});
    expect(() => readProviderKeyStoreForUpdate(dir)).toThrow(/cannot be read/);
    fs.chmodSync(p, 0o600);
  });
});

describe("readJsonForUpdate: absent and empty are the only silent cases", () => {
  it("returns undefined rather than a value, so callers cannot confuse it with data", () => {
    expect(readJsonForUpdate(path.join(root, "nope.json"), wrap, () => true, "x")).toBeUndefined();
    expect(readJsonForUpdate(fixture(""), wrap, () => true, "x")).toBeUndefined();
  });

  it("applies the caller's own shape check, and names the expected shape when it fails", () => {
    const p = fixture('{"a":1}');
    expect(() => readJsonForUpdate(p, wrap, (v) => Array.isArray(v), "a list of keys")).toThrow(
      /is not a list of keys/,
    );
    // Same bytes, a check that accepts them: no throw.
    expect(
      readJsonForUpdate<{ a: number }>(p, wrap, (v) => typeof v === "object", "an object"),
    ).toEqual({ a: 1 });
  });
});
