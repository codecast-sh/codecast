// Audit an `expo export --source-maps` artifact before it ships.
//   bun scripts/audit-export.mjs <export-dir>
//
// Two native libraries in one bundle register the same native view twice and
// the app dies at launch ("Tried to register two views with the same name
// RNSVGCircle", 2026-09-14). The source map names every module that went in,
// so one package root per native library, per platform, is checkable here.
// The session faces draw the web package's WebP art, so the same pass checks
// that all 24 files made it into the bundle.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const NATIVE_SINGLETONS = ['react-native-svg', 'react-native-safe-area-context', 'react-native', 'react'];
const FACE_ART = '/web/components/org/avatars/';

const root = process.argv[2];
assert.ok(root, 'usage: bun scripts/audit-export.mjs <export-dir>');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
for (const [platform, meta] of Object.entries(metadata.fileMetadata)) {
  const map = JSON.parse(fs.readFileSync(path.join(root, meta.bundle + '.map'), 'utf8'));
  const copies = {};
  for (const name of NATIVE_SINGLETONS) {
    const roots = new Set(map.sources.filter((s) => s.includes(`/node_modules/${name}/`)).map((s) => s.split(`/node_modules/${name}/`)[0]));
    assert.equal(roots.size, 1, `${platform}: ${roots.size} copies of ${name}: ${[...roots].join(', ')}`);
    copies[name] = roots.size;
  }
  const faces = map.sources.filter((s) => s.includes(FACE_ART) && s.endsWith('.webp'));
  assert.equal(faces.length, 24, `${platform}: ${faces.length} of 24 face files in the bundle`);
  console.log(JSON.stringify({ platform, copies, faces: faces.length, assets: meta.assets.length, bundle: meta.bundle }));
}
