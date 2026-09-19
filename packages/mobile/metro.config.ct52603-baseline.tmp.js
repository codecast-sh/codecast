const { getDefaultConfig } = require('expo/metro-config');
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
const nativeSingletonPackages = ['react-native-svg', 'react-native-safe-area-context'];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (nativeSingletonPackages.some(pkg => moduleName === pkg || moduleName.startsWith(pkg + '/'))) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, 'index.ts') },
      moduleName,
      platform,
    );
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
