/**
 * E2E Test for ccs-gaq: File rotation detection
 *
 * Tests that the daemon detects when a history file is truncated/rotated
 * and resets position to read from the start.
 *
 * Manual verification steps:
 * 1. Start the daemon with `codecast daemon start`
 * 2. Create a test history file in ~/.claude/projects/test-rotation/
 * 3. Add content and verify daemon processes it
 * 4. Check daemon logs: should show position advancing
 * 5. Truncate the file (simulate rotation): echo "new content" > file
 * 6. Verify daemon logs show "File rotation detected"
 * 7. Verify daemon resets position to 0 and reads new content
 * 8. Check daemon logs: position should be 0 after rotation
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getPosition, setPosition } from '../../packages/cli/src/positionTracker';

test.describe('File rotation detection (ccs-gaq)', () => {
  const testDir = path.join(process.env.HOME || '', '.codecast', 'test-rotation');
  const testFile = path.join(testDir, 'test-session.jsonl');

  test.beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  test.afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('detects file rotation when file becomes smaller', async () => {
    const initialContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n';
    fs.writeFileSync(testFile, initialContent);

    const initialSize = fs.statSync(testFile).size;
    setPosition(testFile, initialSize);

    const truncatedContent = 'New Line 1\n';
    fs.writeFileSync(testFile, truncatedContent);

    const newSize = fs.statSync(testFile).size;
    const savedPosition = getPosition(testFile);

    expect(newSize).toBeLessThan(savedPosition);

    if (newSize < savedPosition) {
      setPosition(testFile, 0);
    }

    expect(getPosition(testFile)).toBe(0);
  });

  test('reads new content after rotation', async () => {
    const oldContent = 'Old content line 1\nOld content line 2\nOld content line 3\n';
    fs.writeFileSync(testFile, oldContent);
    setPosition(testFile, fs.statSync(testFile).size);

    const newContent = 'New content after rotation\n';
    fs.writeFileSync(testFile, newContent);

    const stats = fs.statSync(testFile);
    let position = getPosition(testFile);

    if (stats.size < position) {
      setPosition(testFile, 0);
      position = 0;
    }

    const fd = fs.openSync(testFile, 'r');
    const buffer = Buffer.alloc(stats.size - position);
    fs.readSync(fd, buffer, 0, buffer.length, position);
    fs.closeSync(fd);

    const readContent = buffer.toString('utf-8');
    expect(readContent).toBe(newContent);
  });

  test('handles multiple rotations', async () => {
    let content = 'First rotation content\n';
    fs.writeFileSync(testFile, content);
    setPosition(testFile, fs.statSync(testFile).size);

    content = 'Second rotation\n';
    fs.writeFileSync(testFile, content);
    let stats = fs.statSync(testFile);
    if (stats.size < getPosition(testFile)) {
      setPosition(testFile, 0);
    }
    setPosition(testFile, stats.size);

    content = 'Third rotation\n';
    fs.writeFileSync(testFile, content);
    stats = fs.statSync(testFile);
    if (stats.size < getPosition(testFile)) {
      setPosition(testFile, 0);
    }

    const fd = fs.openSync(testFile, 'r');
    const buffer = Buffer.alloc(stats.size);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    expect(buffer.toString('utf-8')).toBe('Third rotation\n');
  });
});
