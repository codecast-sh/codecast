// Explicit config exists for ONE reason: shared @codecast/web modules use
// import.meta (Vite), which Hermes can't parse. The transform rewrites the
// syntax so the bundle builds; the shim has no .env, so readers must
// null-guard (see web/store/local-first/featureFlags.ts) — flags degrade to
// "off" on mobile rather than crashing at module load.
module.exports = function (api) {
  api.cache(true);
  return {
    // require.resolve: shared ../web modules are transformed too, and babel
    // resolves string preset names relative to the file being transformed —
    // which can't see mobile's node_modules under bun's isolated layout.
    presets: [[require.resolve("babel-preset-expo"), { unstable_transformImportMeta: true }]],
  };
};
