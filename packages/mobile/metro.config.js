const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watchman on this machine wedges on the workspace crawl ("Waiting for
// Watchman query") and never serves a bundle. Node's crawler is slower to
// start and always finishes. METRO_NO_WATCHMAN=1 used to be the opt-in;
// export/OTA cannot depend on a wedged daemon.
config.resolver.useWatchman = false;

config.watchFolders = [workspaceRoot];
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(defaultBlockList) ? defaultBlockList : defaultBlockList ? [defaultBlockList] : []),
  /[/\\]\.claude[/\\]worktrees[/\\].*/,
  /[/\\]\.codecast[/\\]worktrees[/\\].*/,
  /[/\\]\.conductor[/\\].*/,
  /[/\\]dist-perf[/\\].*/,
];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const mobileModules = path.resolve(projectRoot, 'node_modules');
const singletonPackages = ['react', 'react-native', 'react-dom'];

// A binary holds ONE copy of each native library, so the bundle must hold one
// copy of its JS. bun keeps a separate install of a package for each set of
// peers, and a nested SDK that resolves its own copy registers every native
// view a second time ("Tried to register two views with the same name
// RNSVGCircle" crashed production). The same holds for JS that owns a context
// or a client (@react-navigation/native, Sentry, PostHog): two copies means two
// worlds, and twice the code to evaluate at boot. So every package the app
// names in its own package.json is resolved from the app root, whoever imports
// it. The rule is computed, not listed: a new dependency is covered the day it
// is installed. Transitive packages follow, because only the app's copy of
// their parent is ever on the graph.
// The origin a package must resolve from, or null to leave it alone: the app
// root for what package.json names, the app's own `expo` install for what expo
// provides (expo-asset, expo-modules-core, expo-file-system arrive through
// several parents, each with its own copy).
const appOrigin = path.join(projectRoot, 'index.ts');
const expoRoot = fs.realpathSync(path.join(mobileModules, 'expo'));
const expoOrigin = path.join(expoRoot, 'package.json');
const expoSiblings = path.dirname(expoRoot);
const singletonOriginCache = new Map();
function packageNameOf(moduleName) {
  if (moduleName.startsWith('.') || path.isAbsolute(moduleName)) return null;
  const parts = moduleName.split('/');
  return moduleName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
function singletonOrigin(moduleName) {
  const name = packageNameOf(moduleName);
  if (!name || singletonPackages.includes(name)) return null;
  if (!singletonOriginCache.has(name)) {
    const has = dir => fs.existsSync(path.join(dir, name, 'package.json'));
    singletonOriginCache.set(name, has(mobileModules) ? appOrigin : has(expoSiblings) ? expoOrigin : null);
  }
  return singletonOriginCache.get(name);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = singletonOrigin(moduleName);
  if (origin) {
    return context.resolveRequest({ ...context, originModulePath: origin }, moduleName, platform);
  }
  const isSingleton = singletonPackages.some(
    pkg => moduleName === pkg || moduleName.startsWith(pkg + '/')
  );
  if (isSingleton) {
    const resolved = require.resolve(moduleName, { paths: [mobileModules] });
    return { type: 'sourceFile', filePath: resolved };
  }
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (e) {
    // Shared TS packages (NodeNext) import relative modules by their emitted
    // .js name; Metro reads the .ts source, so retry without the extension.
    if (/^\.\.?\//.test(moduleName) && moduleName.endsWith('.js')) {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    }
    throw e;
  }
};

module.exports = config;
