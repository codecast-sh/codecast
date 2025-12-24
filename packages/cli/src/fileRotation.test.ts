import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { getPosition, setPosition, clearPosition } from "./positionTracker.js";

describe("File rotation detection", () => {
  const testDir = path.join(process.env.HOME || "", ".codecast", "test-rotation");
  const testFile = path.join(testDir, "history.jsonl");

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    clearPosition(testFile);
  });

  it("should detect when file size is less than saved position", () => {
    fs.writeFileSync(testFile, "Line 1\nLine 2\nLine 3\n");
    const initialSize = fs.statSync(testFile).size;
    setPosition(testFile, initialSize);

    fs.writeFileSync(testFile, "New Line 1\n");
    const newSize = fs.statSync(testFile).size;

    const savedPosition = getPosition(testFile);
    expect(newSize).toBeLessThan(savedPosition);
  });

  it("should reset position to 0 when rotation is detected", () => {
    fs.writeFileSync(testFile, "Original content that is quite long\n");
    const originalSize = fs.statSync(testFile).size;
    setPosition(testFile, originalSize);

    fs.writeFileSync(testFile, "Short\n");

    const savedPosition = getPosition(testFile);
    const newSize = fs.statSync(testFile).size;

    if (newSize < savedPosition) {
      setPosition(testFile, 0);
    }

    expect(getPosition(testFile)).toBe(0);
  });

  it("should read from start after rotation reset", () => {
    fs.writeFileSync(testFile, "Old content line 1\nOld content line 2\n");
    setPosition(testFile, fs.statSync(testFile).size);

    fs.writeFileSync(testFile, "New line after rotation\n");
    const stats = fs.statSync(testFile);
    let position = getPosition(testFile);

    if (stats.size < position) {
      setPosition(testFile, 0);
      position = 0;
    }

    const fd = fs.openSync(testFile, "r");
    const buffer = Buffer.alloc(stats.size - position);
    fs.readSync(fd, buffer, 0, buffer.length, position);
    fs.closeSync(fd);

    const content = buffer.toString("utf-8");
    expect(content).toBe("New line after rotation\n");
  });
});
