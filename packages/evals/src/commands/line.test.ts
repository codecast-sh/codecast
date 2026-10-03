import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { pinMissingImports } from './line';

// The base worktree runs this checkout's eval tool against the base's prod
// code. A tool import the base cannot satisfy reads this checkout's module; a
// surface adapter's imports always stay the base's.

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('pinMissingImports', () => {
  test('pins only tool imports whose values the base lacks', () => {
    const wt = mkdtempSync(join(tmpdir(), 'line-pin-wt-'));
    const own = mkdtempSync(join(tmpdir(), 'line-pin-own-'));
    const pkg = join(wt, 'packages', 'evals');
    put(wt, 'packages/lib/h.ts', 'export const x = 1;\nexport type T = 1;\n');
    put(own, 'packages/lib/h.ts', 'export const x = 1;\nexport const y = 2;\nexport type T = 1;\n');
    put(own, 'packages/lib/gone.ts', 'export const z = 3;\n');
    put(pkg, 'src/needsNew.ts', "import { x, y as why } from '../../lib/h';\n");
    put(pkg, 'src/baseHas.ts', "import { x, type T } from '../../lib/h';\nexport { x as CALL } from '../../lib/h';\n");
    put(pkg, 'src/typeOnly.ts', "import type { T } from '../../lib/h';\n");
    put(pkg, 'src/deep/fileGone.ts', "import { z } from '../../../lib/gone';\n");
    put(pkg, 'src/local.ts', "import { x } from './baseHas';\n");
    put(pkg, 'src/surfaces/s/index.ts', "import { y } from '../../../../lib/h';\n");

    const pinned = pinMissingImports(pkg, wt, own);

    expect(pinned.sort()).toEqual(['src/deep/fileGone.ts: packages/lib/gone.ts', 'src/needsNew.ts: packages/lib/h.ts']);
    expect(readFileSync(join(pkg, 'src/needsNew.ts'), 'utf8')).toBe(`import { x, y as why } from '${join(own, 'packages/lib/h.ts')}';\n`);
    expect(readFileSync(join(pkg, 'src/deep/fileGone.ts'), 'utf8')).toBe(`import { z } from '${join(own, 'packages/lib/gone.ts')}';\n`);
    expect(readFileSync(join(pkg, 'src/baseHas.ts'), 'utf8')).toBe("import { x, type T } from '../../lib/h';\nexport { x as CALL } from '../../lib/h';\n");
    expect(readFileSync(join(pkg, 'src/typeOnly.ts'), 'utf8')).toBe("import type { T } from '../../lib/h';\n");
    expect(readFileSync(join(pkg, 'src/local.ts'), 'utf8')).toBe("import { x } from './baseHas';\n");
    expect(readFileSync(join(pkg, 'src/surfaces/s/index.ts'), 'utf8')).toBe("import { y } from '../../../../lib/h';\n");
  });
});
