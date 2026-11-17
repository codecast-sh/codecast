// Outside agents connected over MCP (docs/architecture/agent-mcp.md). The rows
// live in `mcpConnections` (clientSyncRegistry, fed by mcpAuth.listConnections
// from Settings › Connected agents); Disconnect drops the row on the press and
// rides `dispatch` to the side effect of the same name.
import { action } from "./mutativeMiddleware";

/** One row as mcpAuth.listConnections shapes it. */
export type McpConnectionRow = {
  _id: string;
  kind: "grant" | "cast_token";
  name: string;
  host: string | null;
  created_at: number;
  last_used_at: number | null;
};

export type AgentConnectionsSliceActions = {
  disconnectAgent: (kind: McpConnectionRow["kind"], id: string) => void;
};

export function createAgentConnectionsSlice(): AgentConnectionsSliceActions {
  return {
    disconnectAgent: action(function (this: any, _kind: McpConnectionRow["kind"], id: string) {
      delete this.mcpConnections[id];
    }) as AgentConnectionsSliceActions["disconnectAgent"],
  };
}
