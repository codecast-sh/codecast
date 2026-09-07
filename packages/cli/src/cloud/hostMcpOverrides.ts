import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../atomicWrite.js";

export type McpHarness = "codex" | "claude";
export type McpStatus = "ok" | "missing_portable" | "unsupported";
export interface McpPin { enabled: false; reason: string; source_command: string; at: string }
export interface HostMcpOverrides { version: 1; codex: Record<string, McpPin>; claude: Record<string, McpPin> }
export interface McpSourceServer { command: string; args?: string[] }
export interface McpClassified extends McpSourceServer { name: string; status: McpStatus; reason?: string }

export function hostMcpOverridesPath(home: string): string { return path.join(home, ".codecast", "host-mcp-overrides.json"); }
export function emptyOverrides(): HostMcpOverrides { return { version: 1, codex: {}, claude: {} }; }
export function readHostMcpOverrides(home: string): HostMcpOverrides {
  try {
    const value = JSON.parse(fs.readFileSync(hostMcpOverridesPath(home), "utf8"));
    if (value?.version !== 1 || [value.codex, value.claude].some((table) => !table || typeof table !== "object" || Array.isArray(table) || Object.values(table).some((entry: any) => entry?.enabled !== false || typeof entry.reason !== "string" || typeof entry.source_command !== "string" || typeof entry.at !== "string"))) return emptyOverrides();
    return value;
  } catch { return emptyOverrides(); }
}
export function writeHostMcpOverrides(home: string, overrides: HostMcpOverrides): void {
  const file = hostMcpOverridesPath(home);
  const dir = path.dirname(file);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("MCP override directory is a symlink");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(file, JSON.stringify(overrides, null, 2) + "\n", { mode: 0o600 });
}
export function normalizeCommand(server: McpSourceServer): string {
  const home = process.env.HOME || os.homedir();
  return [server.command, ...(server.args ?? [])].join(" ").replace(/(^|[\s"'])~\//g, (_all, before) => `${before}${home}/`).replace(/\$\{HOME\}|\$HOME\b/g, () => home).replace(/\s+/g, " ").trim();
}
export function maskPins(overrides: HostMcpOverrides, harness: McpHarness, currentSource: Record<string, McpSourceServer>): { pinned: string[]; dropped: string[]; next: HostMcpOverrides } {
  const pinned: string[] = [];
  const dropped: string[] = [];
  const next = structuredClone(overrides);
  for (const [name, pin] of Object.entries(overrides[harness])) {
    if (currentSource[name] && pin.source_command === normalizeCommand(currentSource[name]!)) pinned.push(name);
    else { dropped.push(name); delete next[harness][name]; }
  }
  return { pinned, dropped, next };
}
export function reconcilePins(overrides: HostMcpOverrides, harness: McpHarness, classified: McpClassified[], at: string): HostMcpOverrides {
  return { ...structuredClone(overrides), [harness]: Object.fromEntries(classified.filter((server) => server.status === "unsupported").map((server) => [server.name, { enabled: false, reason: server.reason ?? "unsupported on this host", source_command: normalizeCommand(server), at }])) };
}
