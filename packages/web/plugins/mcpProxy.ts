// Dev parity for codecast for outside agents (docs/architecture/agent-mcp.md):
// the dev server forwards each public MCP path (/mcp, /oauth/token, the
// well-known documents) to its Convex site path, as codecast.sh does in prod
// (server/index.ts), so an agent can connect to a local `cast dev`.
import { loadEnv, type Plugin } from "vite";
import { MCP_ROUTES } from "../../shared/contracts/agentAccess";

const DEFAULT_CONVEX_URL = "https://convex.codecast.sh";

export function mcpProxyPlugin(): Plugin {
  return {
    name: "codecast-mcp-proxy",
    config(_cfg, { mode }) {
      const env = loadEnv(mode, process.cwd(), "");
      const convex = process.env.VITE_CONVEX_URL || env.VITE_CONVEX_URL || DEFAULT_CONVEX_URL;
      const site = (env.CONVEX_SITE_URL || convex.replace(".convex.cloud", ".convex.site").replace(":3210", ":3211")).replace(/\/+$/, "");
      const proxy = Object.fromEntries(
        Object.entries(MCP_ROUTES).map(([path, backend]) => [
          `^${path.replace(/[.]/g, "\\.")}(\\?.*)?$`,
          { target: site, changeOrigin: true, rewrite: (url: string) => backend + (url.includes("?") ? url.slice(url.indexOf("?")) : "") },
        ]),
      );
      return { server: { proxy } };
    },
  };
}
