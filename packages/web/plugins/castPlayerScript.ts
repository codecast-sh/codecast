import type { Plugin } from "vite";
import { castPlayerScript } from "../../convex/convex/lib/castPlayer";

/**
 * Serves /cast-player.js, the <cast-player> element published pages use, from
 * this origin so a page here can load it as an ordinary same-origin script.
 * The source lives once, in convex/lib/castPlayer.ts; this emits it into the
 * build and answers it in dev. Pages here build their own players, so the
 * published-page upgrade of plain <video> elements stays off.
 */
const FILE = "cast-player.js";

export function castPlayerScriptPlugin(): Plugin {
  const source = () => castPlayerScript({ upgradeVideos: false });
  return {
    name: "codecast-cast-player-script",
    configureServer(server) {
      server.middlewares.use(`/${FILE}`, (_req, res) => {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: FILE, source: source() });
    },
  };
}
