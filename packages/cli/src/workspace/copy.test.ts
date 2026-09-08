import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copyFileMode, copyFiles } from "./copy.js";
import type { WorkspaceManifest } from "./types.js";

let mainDir: string;
let wtDir: string;

beforeEach(() => {
  mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-copy-main-"));
  wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-copy-wt-"));
});

afterEach(() => {
  fs.rmSync(mainDir, { recursive: true, force: true });
  fs.rmSync(wtDir, { recursive: true, force: true });
});

function writeMain(rel: string, content: string): void {
  const p = path.join(mainDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function readWt(rel: string): string {
  return fs.readFileSync(path.join(wtDir, rel), "utf-8");
}

function manifest(copy: string[]): WorkspaceManifest {
  return {
    setup: { copy, share: [], install: [], generate: [], migrate: [] },
    ports: {},
    services: {},
    env: {},
    teardown: { run: [] },
    browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
  backend: "local",
  };
}

// Silent logger for tests that want to assert on the absence of console noise.
const silent = () => undefined;

describe("copyFiles", () => {
  test("copies .env, .env.local, credentials", () => {
    writeMain(".env", "FOO=1");
    writeMain(".env.local", "BAR=2");
    writeMain("credentials.json", "{}");

    const r = copyFiles(
      manifest([".env", ".env.local", "credentials.json"]),
      mainDir,
      wtDir,
      { log: silent },
    );
    expect(r.copied).toEqual([".env", ".env.local", "credentials.json"]);
    expect(readWt(".env")).toBe("FOO=1");
    expect(readWt(".env.local")).toBe("BAR=2");
    expect(readWt("credentials.json")).toBe("{}");
  });

  test("missing source file is skipped, not an error", () => {
    writeMain(".env", "FOO=1");
    const logs: string[] = [];
    const r = copyFiles(
      manifest([".env", ".env.local"]),
      mainDir,
      wtDir,
      { log: (m) => logs.push(m) },
    );
    expect(r.copied).toEqual([".env"]);
    expect(r.skippedMissing).toEqual([".env.local"]);
    expect(logs.some((l) => l.includes(".env.local"))).toBe(true);
  });

  test("existing target file is preserved (no overwrite by default)", () => {
    writeMain(".env", "FROM_MAIN");
    fs.writeFileSync(path.join(wtDir, ".env"), "LOCAL_EDITS");

    const r = copyFiles(manifest([".env"]), mainDir, wtDir, { log: silent });
    expect(r.copied).toEqual([]);
    expect(r.skippedExisting).toEqual([".env"]);
    expect(readWt(".env")).toBe("LOCAL_EDITS");
  });

  test("overwrite=true replaces existing target", () => {
    writeMain(".env", "FROM_MAIN");
    fs.writeFileSync(path.join(wtDir, ".env"), "LOCAL_EDITS");

    const r = copyFiles(manifest([".env"]), mainDir, wtDir, {
      log: silent,
      overwrite: true,
    });
    expect(r.copied).toEqual([".env"]);
    expect(readWt(".env")).toBe("FROM_MAIN");
  });

  test("nested paths create intermediate directories", () => {
    writeMain("packages/web/.env.local", "NESTED=1");
    const r = copyFiles(manifest(["packages/web/.env.local"]), mainDir, wtDir, {
      log: silent,
    });
    expect(r.copied).toEqual(["packages/web/.env.local"]);
    expect(readWt("packages/web/.env.local")).toBe("NESTED=1");
  });

  test("directory copies recursively", () => {
    writeMain("secrets/key.pem", "KEY");
    writeMain("secrets/cert.pem", "CERT");
    writeMain("secrets/nested/inner.txt", "INNER");

    const r = copyFiles(manifest(["secrets"]), mainDir, wtDir, { log: silent });
    expect(r.copied).toEqual(["secrets"]);
    expect(readWt("secrets/key.pem")).toBe("KEY");
    expect(readWt("secrets/cert.pem")).toBe("CERT");
    expect(readWt("secrets/nested/inner.txt")).toBe("INNER");
  });

  test("empty copy list yields empty result", () => {
    const r = copyFiles(manifest([]), mainDir, wtDir, { log: silent });
    expect(r).toEqual({ copied: [], skippedMissing: [], skippedExisting: [] });
  });

  test("idempotent: running twice doesn't error or duplicate", () => {
    writeMain(".env", "X");
    copyFiles(manifest([".env"]), mainDir, wtDir, { log: silent });
    const r = copyFiles(manifest([".env"]), mainDir, wtDir, { log: silent });
    expect(r.copied).toEqual([]);
    expect(r.skippedExisting).toEqual([".env"]);
    expect(readWt(".env")).toBe("X");
  });
});

/**
 * Record the mode each copyFileSync call asks for, still writing the file so
 * the copier behaves normally. `refuseClone` makes the cloning call fail the
 * way a filesystem without reflinks does.
 */
function recordCopyModes(opts: { refuseClone?: boolean } = {}) {
  const seen: (number | undefined)[] = [];
  const real = fs.copyFileSync;
  const spy = spyOn(fs, "copyFileSync").mockImplementation(((
    src: fs.PathLike,
    dest: fs.PathLike,
    mode?: number,
  ) => {
    seen.push(mode);
    if (opts.refuseClone && mode) throw new Error("ENOTSUP: clone refused");
    real(src, dest);
  }) as typeof fs.copyFileSync);
  return { seen, restore: () => spy.mockRestore() };
}

describe("copy-on-write clones", () => {
  test("asks for a clone on macOS and a plain copy elsewhere", () => {
    expect(copyFileMode("darwin")).toBe(fs.constants.COPYFILE_FICLONE);
    expect(copyFileMode("linux")).toBe(0);
    expect(copyFileMode("win32")).toBe(0);
  });

  test("passes the clone flag to copyFileSync on darwin", () => {
    writeMain(".env", "FOO=1");
    const modes = recordCopyModes();
    try {
      copyFiles(manifest([".env"]), mainDir, wtDir, { log: silent, platform: "darwin" });
    } finally {
      modes.restore();
    }
    expect(modes.seen).toEqual([fs.constants.COPYFILE_FICLONE]);
    expect(readWt(".env")).toBe("FOO=1");
  });

  test("copies with no flags on other platforms", () => {
    writeMain(".env", "FOO=1");
    const modes = recordCopyModes();
    try {
      copyFiles(manifest([".env"]), mainDir, wtDir, { log: silent, platform: "linux" });
    } finally {
      modes.restore();
    }
    expect(modes.seen).toEqual([0]);
    expect(readWt(".env")).toBe("FOO=1");
  });

  test("a refused clone falls back to a plain copy", () => {
    writeMain(".env", "FOO=1");
    const modes = recordCopyModes({ refuseClone: true });
    try {
      const r = copyFiles(manifest([".env"]), mainDir, wtDir, {
        log: silent,
        platform: "darwin",
      });
      expect(r.copied).toEqual([".env"]);
    } finally {
      modes.restore();
    }
    expect(modes.seen).toEqual([fs.constants.COPYFILE_FICLONE, 0]);
    expect(readWt(".env")).toBe("FOO=1");
  });

  test("directories clone too, and keep their contents", () => {
    writeMain("secrets/key.pem", "KEY");
    writeMain("secrets/nested/inner.txt", "INNER");

    const r = copyFiles(manifest(["secrets"]), mainDir, wtDir, {
      log: silent,
      platform: "darwin",
    });
    expect(r.copied).toEqual(["secrets"]);
    expect(readWt("secrets/key.pem")).toBe("KEY");
    expect(readWt("secrets/nested/inner.txt")).toBe("INNER");
  });
});
