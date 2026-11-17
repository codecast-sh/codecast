// The outside agents connected to this account over MCP, from the store
// (mcpConnections), with the feeder that fills it (mcpAuth.listConnections).
// Mounted by Settings › Connected agents, the one surface that shows them.
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import type { McpConnectionRow } from "../store/agentConnectionsSlice";

const rowSig = (r: McpConnectionRow) => `${r.name}|${r.host}|${r.last_used_at}`;
const recentFirst = (a: McpConnectionRow, b: McpConnectionRow) => (b.last_used_at ?? b.created_at) - (a.last_used_at ?? a.created_at);

export function useMcpConnections(): { rows: McpConnectionRow[]; ready: boolean } {
  const { ready } = useSyncCollection("mcpConnections", api.mcpAuth.listConnections, {});
  const rows = useCollectionRows<McpConnectionRow>("mcpConnections", { sig: rowSig, sort: recentFirst });
  return { rows, ready };
}
