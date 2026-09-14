const { afterAll, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const config = require('./metro.config.js');
const expoRequire = createRequire(require.resolve('expo/metro-config'));
const metroRequire = createRequire(expoRequire.resolve('@expo/metro-config'));
const { resolve } = metroRequire('metro-resolver');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-svg-peer-'));
const peer = path.join(fixture, 'node_modules/react-native-svg');
fs.mkdirSync(path.join(peer, 'src/fabric'), { recursive: true });
fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({
  name: 'react-native-svg',
  version: '15.12.1',
  'react-native': 'src/index.ts',
}));
fs.writeFileSync(path.join(peer, 'src/index.ts'), 'export {};');
fs.writeFileSync(path.join(peer, 'src/fabric/CircleNativeComponent.ts'), 'export {};');
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
  for (const name of ['react-native-svg', 'react-native-svg/src/fabric/CircleNativeComponent']) {
    test(`${platform}: app and nested SDK share ${name}`, () => {
      const app = context(path.join(__dirname, 'index.ts'));
      const sdk = context(path.join(fixture, 'index.js'));
      const expected = resolve(app, name, platform);
      expect(expected.filePath).toContain('/react-native-svg/src/');
      expect(resolve(sdk, name, platform).filePath).not.toBe(expected.filePath);
      expect(config.resolver.resolveRequest(sdk, name, platform)).toEqual(expected);
      expect(config.resolver.resolveRequest(app, name, platform)).toEqual(expected);
    });
  }
}
