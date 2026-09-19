const { afterAll, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const config = require('./metro.config.js');
const expoRequire = createRequire(require.resolve('expo/metro-config'));
const metroRequire = createRequire(expoRequire.resolve('@expo/metro-config'));
const { resolve } = metroRequire('metro-resolver');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-native-peer-'));
const packages = [
  { name: 'react-native-svg', entry: 'src/index.ts', component: 'src/fabric/CircleNativeComponent' },
  { name: 'react-native-safe-area-context', entry: 'src/index.tsx', component: 'src/specs/NativeSafeAreaProvider' },
];
for (const { name, entry, component } of packages) {
  const peer = path.join(fixture, 'node_modules', name);
  fs.mkdirSync(path.join(peer, path.dirname(component)), { recursive: true });
  fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name, 'react-native': entry }));
  fs.writeFileSync(path.join(peer, entry), 'export {};');
  fs.writeFileSync(path.join(peer, component + '.ts'), 'export {};');
}
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

function getPackage(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function getPackageForModule(file) {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && path.basename(dir) !== 'node_modules') {
    const packageJson = getPackage(path.join(dir, 'package.json'));
    if (packageJson) return { rootPath: dir, packageJson, packageRelativePath: path.relative(dir, file) };
    dir = path.dirname(dir);
  }
  return null;
}

function context(originModulePath) {
  return {
    ...config.resolver,
    originModulePath,
    mainFields: config.resolver.resolverMainFields,
    assetExts: new Set(config.resolver.assetExts),
    allowHaste: false,
    preferNativePlatform: true,
    getPackage,
    getPackageForModule,
    doesFileExist: fs.existsSync,
    fileSystemLookup: file => {
      if (!fs.existsSync(file)) return { exists: false };
      return { exists: true, type: fs.statSync(file).isDirectory() ? 'd' : 'f', realPath: fs.realpathSync(file) };
    },
    redirectModulePath: file => file,
    resolveAsset: () => null,
    resolveRequest: resolve,
    unstable_logWarning: () => {},
  };
}

for (const platform of ['ios', 'android']) {
  for (const pkg of packages) {
    for (const name of [pkg.name, `${pkg.name}/${pkg.component}`]) {
      test(`${platform}: app and nested SDK share ${name}`, () => {
        const app = context(path.join(__dirname, 'index.ts'));
        const sdk = context(path.join(fixture, 'index.js'));
        const expected = resolve(app, name, platform);
        expect(expected.filePath).toContain(`/${pkg.name}/src/`);
        expect(resolve(sdk, name, platform).filePath).not.toBe(expected.filePath);
        expect(config.resolver.resolveRequest(sdk, name, platform)).toEqual(expected);
        expect(config.resolver.resolveRequest(app, name, platform)).toEqual(expected);
      });
    }
  }
}

// Session faces (components/identity) reach across the workspace for their art
// and carry the agent brand as a badge, which draws through react-native-svg.
// Every module on that path must land on the app's one pinned copy.
const faceOrigins = [
  path.join(__dirname, 'components/identity/MobileSessionFace.tsx'),
  path.join(__dirname, 'components/AgentLogo.tsx'),
  path.join(__dirname, '../web/components/org/avatars/index.tsx'),
  path.join(__dirname, '../web/lib/sessionIdentity.ts'),
];
for (const platform of ['ios', 'android']) {
  for (const pkg of packages) {
    test(`${platform}: the session face path resolves the pinned ${pkg.name}`, () => {
      const expected = resolve(context(path.join(__dirname, 'index.ts')), pkg.name, platform);
      for (const origin of faceOrigins) {
        expect(fs.existsSync(origin)).toBe(true);
        expect(config.resolver.resolveRequest(context(origin), pkg.name, platform)).toEqual(expected);
      }
    });
  }
}

test('the face art is an asset Metro bundles: all 24 WebP files, from the web package', () => {
  expect(config.resolver.assetExts).toContain('webp');
  const art = path.join(__dirname, '../web/components/org/avatars');
  expect(config.watchFolders.some(dir => art.startsWith(dir + path.sep))).toBe(true);
  expect(fs.readdirSync(art).filter(f => f.endsWith('.webp')).length).toBe(24);
});

// The rule is computed from package.json, so it must cover every dependency the
// app names, not the two that crashed first. For each one, a nested SDK with
// its own copy must still get the app's copy.
const appDeps = Object.keys(require('./package.json').dependencies).filter(
  name => !['react', 'react-native', 'react-dom'].includes(name),
);

test('package.json names the packages that were doubled in a real bundle', () => {
  for (const name of ['react-native-screens', '@sentry/react-native', 'posthog-react-native', '@react-navigation/native', 'expo']) {
    expect(appDeps).toContain(name);
  }
});

for (const name of appDeps) {
  const app = context(path.join(__dirname, 'index.ts'));
  let expected;
  try {
    expected = resolve(app, name, 'ios');
  } catch {
    continue; // config plugins and build tools have no JS entry to bundle
  }
  test(`a nested copy of ${name} resolves to the app's copy`, () => {
    const peer = path.join(fixture, 'node_modules', name);
    if (!fs.existsSync(path.join(peer, 'package.json'))) {
      fs.mkdirSync(peer, { recursive: true });
      fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
      fs.writeFileSync(path.join(peer, 'index.js'), 'module.exports = {};');
    }
    const sdk = context(path.join(fixture, 'index.js'));
    expect(resolve(sdk, name, 'ios').filePath).toContain(fixture);
    expect(config.resolver.resolveRequest(sdk, name, 'ios')).toEqual(expected);
  });
}

// What expo provides arrives through several parents, each with its own copy
// (two expo-asset installs shipped in one release bundle). Those resolve from
// the app's own expo install, whoever imports them.
const expoRoot = fs.realpathSync(path.join(__dirname, 'node_modules', 'expo'));
for (const name of ['expo-asset', 'expo-modules-core', 'expo-file-system']) {
  test(`a nested copy of ${name} resolves to the copy expo provides`, () => {
    const expected = resolve(context(path.join(expoRoot, 'package.json')), name, 'ios');
    const peer = path.join(fixture, 'node_modules', name);
    if (!fs.existsSync(path.join(peer, 'package.json'))) {
      fs.mkdirSync(peer, { recursive: true });
      fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
      fs.writeFileSync(path.join(peer, 'index.js'), 'module.exports = {};');
    }
    const sdk = context(path.join(fixture, 'index.js'));
    expect(resolve(sdk, name, 'ios').filePath).toContain(fixture);
    expect(config.resolver.resolveRequest(sdk, name, 'ios')).toEqual(expected);
  });
}
