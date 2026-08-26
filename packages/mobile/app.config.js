// Wraps app.json. Android resource names forbid hyphens, so the
// "huddle-ring.caf" iOS ringtone (a cross-platform push contract —
// see shared/contracts/callPush.ts) breaks Android prebuild if the
// sound plugins try to copy it into res/raw. Android rings via the
// Telecom framework's system ringtone instead, so we drop the asset
// from plugin configs on Android builds only. EAS_BUILD_PLATFORM is
// set on EAS build workers during prebuild.
module.exports = ({ config }) => {
  if (process.env.EAS_BUILD_PLATFORM === "android") {
    config.plugins = config.plugins.map((plugin) => {
      if (!Array.isArray(plugin)) return plugin;
      const [name, opts] = plugin;
      if (opts?.sounds) {
        const next = {
          ...opts,
          sounds: opts.sounds.filter((s) => !s.includes("huddle-ring")),
        };
        if (next.defaultRingtoneIos?.includes("huddle-ring")) {
          delete next.defaultRingtoneIos;
        }
        return [name, next];
      }
      return plugin;
    });
  }
  return config;
};
