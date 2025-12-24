import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

describe("Permission Error Handling", () => {
  const testDir = "/tmp/codecast-permission-test";
  const testFile = path.join(testDir, "test.jsonl");

  beforeAll(() => {
    if (fs.existsSync(testDir)) {
      execSync(`rm -rf ${testDir}`);
    }
    fs.mkdirSync(testDir, { recursive: true });

    fs.writeFileSync(testFile, '{"type":"session_meta","session_id":"test","timestamp":1734000000000}\n');
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      execSync(`chmod -R 755 ${testDir}`);
      execSync(`rm -rf ${testDir}`);
    }
  });

  test("fs.statSync may not throw EACCES on macOS for owner", () => {
    fs.chmodSync(testFile, 0o000);

    let didThrow = false;
    try {
      fs.statSync(testFile);
    } catch (err: any) {
      didThrow = true;
      expect(err.code).toBe("EACCES");
    }

    fs.chmodSync(testFile, 0o644);
  });

  test("fs.openSync throws EACCES when file is not readable", () => {
    fs.chmodSync(testFile, 0o000);

    expect(() => {
      fs.openSync(testFile, "r");
    }).toThrow();

    try {
      fs.openSync(testFile, "r");
    } catch (err: any) {
      expect(err.code).toBe("EACCES");
    }

    fs.chmodSync(testFile, 0o644);
  });

  test("fs.readFileSync throws EACCES when file is not readable", () => {
    fs.chmodSync(testFile, 0o000);

    expect(() => {
      fs.readFileSync(testFile, "utf-8");
    }).toThrow();

    try {
      fs.readFileSync(testFile, "utf-8");
    } catch (err: any) {
      expect(err.code).toBe("EACCES");
    }

    fs.chmodSync(testFile, 0o644);
  });

  test("error handling pattern correctly detects permission errors on file read", () => {
    fs.chmodSync(testFile, 0o000);

    const errors: string[] = [];

    try {
      fs.readFileSync(testFile, "utf-8");
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        errors.push(`Permission denied: ${testFile}`);
      } else {
        throw err;
      }
    }

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Permission denied");

    fs.chmodSync(testFile, 0o644);
  });
});
