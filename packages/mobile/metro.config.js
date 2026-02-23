const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const mobileModules = path.resolve(projectRoot, 'node_modules');
const singletonPackages = ['react', 'react-native', 'react-dom'];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSingleton = singletonPackages.some(
    pkg => moduleName === pkg || moduleName.startsWith(pkg + '/')
  );
  if (isSingleton) {
    const resolved = require.resolve(moduleName, { paths: [mobileModules] });
    return { type: 'sourceFile', filePath: resolved };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
