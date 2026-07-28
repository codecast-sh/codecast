import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readProviderKeyStore,
  writeProviderKeyStore,
  applyProviderKeyStoreBlob,
  providerKeyStorePath,
} from "./providerKeyStore";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pks-"));
}

describe("provider-key store", () => {
  it("round-trips a store as a 0600 file and reads {} when absent (the default)", () => {
    const dir = tmpDir();
    try {
      expect(readProviderKeyStore(dir)).toEqual({});
      const content = writeProviderKeyStore(dir, { openrouter: "sk-or-x", anthropic: "sk-ant-y" });
      expect(content).not.toBeNull();
      expect((fs.statSync(providerKeyStorePath(dir)).mode & 0o777).toString(8)).toBe("600");
      expect(readProviderKeyStore(dir)).toEqual({ anthropic: "sk-ant-y", openrouter: "sk-or-x" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the file for an empty store, so a cleared store is a truly absent file", () => {
    const dir = tmpDir();
    try {
      writeProviderKeyStore(dir, { openrouter: "sk-or-x" });
      expect(fs.existsSync(providerKeyStorePath(dir))).toBe(true);
      expect(writeProviderKeyStore(dir, {})).toBeNull();
      expect(fs.existsSync(providerKeyStorePath(dir))).toBe(false);
      expect(readProviderKeyStore(dir)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes deterministically (sorted keys) so content-dedupe on push is stable", () => {
    const dir = tmpDir();
    try {
      const a = writeProviderKeyStore(dir, { openrouter: "1", anthropic: "2" });
      const b = writeProviderKeyStore(dir, { anthropic: "2", openrouter: "1" });
      expect(a).toBe(b);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies a peer's pushed blob, and rejects a malformed one without clobbering", () => {
    const dir = tmpDir();
    try {
      expect(applyProviderKeyStoreBlob(dir, JSON.stringify({ openrouter: "sk-or-z" }))).toBe(true);
      expect(readProviderKeyStore(dir)).toEqual({ openrouter: "sk-or-z" });
      // Garbage / wrong shape → refused, existing store untouched.
      expect(applyProviderKeyStoreBlob(dir, "not json")).toBe(false);
      expect(applyProviderKeyStoreBlob(dir, JSON.stringify(["array"]))).toBe(false);
      expect(readProviderKeyStore(dir)).toEqual({ openrouter: "sk-or-z" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops non-string / empty values on read (a hand-edited or partial file degrades safely)", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(providerKeyStorePath(dir), JSON.stringify({ openrouter: "sk-or-x", bad: 123, empty: "" }));
      expect(readProviderKeyStore(dir)).toEqual({ openrouter: "sk-or-x" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
