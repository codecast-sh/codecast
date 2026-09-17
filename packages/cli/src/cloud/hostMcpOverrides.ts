/**
 * The host-side MCP override manifest: `~/.codecast/host-mcp-overrides.json`.
 *
 * A laptop's MCP definition may name an executable that cannot exist on a
 * Linux host (a `.app` bundle's Mach-O client, a Homebrew-only binary). The
 * laptop config stays canonical; the host readiness path (cloud/hostTools.ts)
 * classifies every configured `mcp_servers.*.command` / `mcpServers.*.command`
 * on each run and is the SOLE WRITER of this manifest: a pin per server that
 * is unsupported on the host, keyed by harness. The home mirror (cloud/mirror)
 * honours it on every apply: after merging the canonical definition it sets
 * `enabled = false` for a pinned codex server, and leaves a pinned claude
 * server out of the host's `~/.claude.json` `mcpServers` entirely, while
 * keeping the rest of the definition fresh. A pin whose `source_command` no
 * longer equals the laptop's current command is dropped by the mirror
 * (`maskPins`): the server changed on the laptop, so readiness must
 * re-classify it.
 *
 * `normalizeCommand` is the one comparison key: it operates on the definition
 * as written on the HOST (after the mirror's laptop to host path remap), with
 * `~` and `$HOME` expanded to the host home, args joined by single spaces and
 * whitespace collapsed. Every `source_command` comparison is host-side
 * against host-side.
 *
 * This module's public surface is agreed with the mirror owners: do not
 * rename or reshape it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../atomicWrite.js";

export type McpHarness = "codex" | "claude";
export type McpStatus = "ok" | "missing_portable" | "unsupported";

export interface McpPin {
  enabled: false;
  reason: string;
  /** normalizeCommand() of the definition when it was pinned (host-side). */
  source_command: string;
  /** ISO time the pin was last (re)confirmed. */
  at: string;
}

export interface HostMcpOverrides {
  version: 1;
  codex: Record<string, McpPin>;
  claude: Record<string, McpPin>;
}

export interface McpSourceServer {
  command: string;
  args?: string[];
}

export interface McpClassified extends McpSourceServer {
  name: string;
  status: McpStatus;
  reason?: string;
}

export const HOST_MCP_OVERRIDES_FILE = "host-mcp-overrides.json";

/** `<home>/.codecast/host-mcp-overrides.json`. */
export function hostMcpOverridesPath(home: string): string {
  return path.join(home, ".codecast", HOST_MCP_OVERRIDES_FILE);
}

export function emptyOverrides(): HostMcpOverrides {
  return { version: 1, codex: {}, claude: {} };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Why `parsed` is not a manifest, or undefined when it is one. The policy
 * is one strict rule shared by readiness and the mirror: the whole manifest
 * is rejected on any malformed table or pin, never salvaged pin by pin, so a
 * damaged file can only mean "no pins" and readiness rewrites it whole.
 */
function invalidReason(parsed: unknown): string | undefined {
  if (!isObject(parsed)) return "not a JSON object";
  if (parsed.version !== 1) return `unknown version ${JSON.stringify(parsed.version)}`;
  for (const harness of ["codex", "claude"] as const) {
    const table = parsed[harness];
    if (!isObject(table)) return `${harness} is not a table of pins`;
    for (const [name, pin] of Object.entries(table)) {
      if (!isObject(pin)) return `${harness}.${name} is not a pin`;
      if (pin.enabled !== false) return `${harness}.${name}.enabled is not false`;
      for (const field of ["reason", "source_command", "at"] as const) if (typeof pin[field] !== "string") return `${harness}.${name}.${field} is not a string`;
    }
  }
  return undefined;
}

function pinsOf(table: Record<string, unknown>): Record<string, McpPin> {
  const out: Record<string, McpPin> = {};
  for (const [name, pin] of Object.entries(table)) {
    const p = pin as Record<string, string>;
    out[name] = { enabled: false, reason: p.reason!, source_command: p.source_command!, at: p.at! };
  }
  return out;
}

/**
 * The manifest from its text. Anything that is not exactly a version 1
 * manifest of well-formed pins reads as emptyOverrides(); `onInvalid` gets
 * the reason so the caller can log or report it.
 */
export function parseHostMcpOverrides(text: string, onInvalid?: (reason: string) => void): HostMcpOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    onInvalid?.(`not JSON (${err instanceof Error ? err.message : String(err)})`);
    return emptyOverrides();
  }
  const reason = invalidReason(parsed);
  if (reason) {
    onInvalid?.(reason);
    return emptyOverrides();
  }
  const o = parsed as Record<"codex" | "claude", Record<string, unknown>>;
  return { version: 1, codex: pinsOf(o.codex), claude: pinsOf(o.claude) };
}

/**
 * Missing file: emptyOverrides(), silently. Invalid file: emptyOverrides()
 * and one line on stderr (or `onInvalid`), because a manifest that exists
 * but does not parse is a fact the operator should see.
 */
export function readHostMcpOverrides(home: string, onInvalid?: (reason: string) => void): HostMcpOverrides {
  const file = hostMcpOverridesPath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return emptyOverrides();
  }
  return parseHostMcpOverrides(text, onInvalid ?? ((reason) => process.stderr.write(`${file} ignored: ${reason}; no MCP pins apply until readiness rewrites it\n`)));
}

/** Canonical bytes: stable key order, 2-space indent, trailing newline. */
export function serializeHostMcpOverrides(o: HostMcpOverrides): string {
  const sortPins = (pins: Record<string, McpPin>) =>
    Object.fromEntries(Object.keys(pins).sort().map((k) => [k, { enabled: false as const, reason: pins[k]!.reason, source_command: pins[k]!.source_command, at: pins[k]!.at }]));
  return JSON.stringify({ version: 1, codex: sortPins(o.codex), claude: sortPins(o.claude) }, null, 2) + "\n";
}

/** mkdir -p ~/.codecast (0700, never through a symlink), write 0600 through a temp file, atomic rename. */
export function writeHostMcpOverrides(home: string, overrides: HostMcpOverrides): void {
  const file = hostMcpOverridesPath(home);
  const dir = path.dirname(file);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("MCP override directory is a symlink");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(file, serializeHostMcpOverrides(overrides), { mode: 0o600 });
}

/**
 * Canonical `"command arg1 arg2"` for a definition as written on the host:
 * `~`, `~/` (also inside quotes), `$HOME` and `${HOME}` expand to `home`
 * (the host home, default this process's), whitespace collapses to single
 * spaces.
 */
export function normalizeCommand(server: McpSourceServer, home: string = process.env.HOME || os.homedir()): string {
  return [String(server.command ?? ""), ...(Array.isArray(server.args) ? server.args.map(String) : [])]
    .join(" ")
    .replace(/(^|[\s"'])~(?=\/|[\s"']|$)/g, (_all, before) => `${before}${home}`)
    .replace(/\$\{HOME\}|\$HOME\b/g, () => home)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pin masking for apply: which of the manifest's pins still match the
 * laptop's CURRENT source (`pinned`: force `enabled = false` / omission for
 * these AFTER merging) and which are dropped (the server is gone or its
 * command changed, so readiness must re-classify it). `next` is the manifest
 * without the dropped pins. Call BEFORE three-way reconciliation.
 * `currentSource` must already be host-side (remapped) definitions.
 */
export function maskPins(
  overrides: HostMcpOverrides,
  harness: McpHarness,
  currentSource: Record<string, McpSourceServer>,
  home?: string,
): { pinned: string[]; dropped: string[]; next: HostMcpOverrides } {
  const pinned: string[] = [];
  const dropped: string[] = [];
  const next = structuredClone(overrides);
  for (const [name, pin] of Object.entries(overrides[harness])) {
    if (currentSource[name] && pin.source_command === normalizeCommand(currentSource[name]!, home)) pinned.push(name);
    else { dropped.push(name); delete next[harness][name]; }
  }
  return { pinned, dropped, next };
}

/**
 * Readiness reconcile: `classified` is the laptop's whole roster for this
 * harness, so the new pin set is exactly its unsupported members. A name now
 * ok / missing_portable, or gone from the laptop, loses its pin. A pin whose
 * command and reason are unchanged keeps its original time; the other
 * harness's pins are untouched. `classified` commands must be host-side
 * (remapped) definitions.
 */
export function reconcilePins(overrides: HostMcpOverrides, harness: McpHarness, classified: McpClassified[], at: string, home?: string): HostMcpOverrides {
  const pins: Record<string, McpPin> = {};
  for (const server of classified) {
    if (server.status !== "unsupported") continue;
    const source_command = normalizeCommand(server, home);
    const prev = overrides[harness][server.name];
    const reason = server.reason ?? prev?.reason ?? "unsupported on this host";
    const unchanged = !!prev && prev.source_command === source_command && prev.reason === reason && !!prev.at;
    pins[server.name] = { enabled: false, reason, source_command, at: unchanged ? prev.at : at };
  }
  return { ...structuredClone(overrides), [harness]: pins };
}

/** `codex: a, b; claude: c`: the one-line summary listings print, or "" when nothing is pinned. */
export function describeHostMcpOverrides(o: HostMcpOverrides): string {
  const parts: string[] = [];
  for (const h of ["codex", "claude"] as const) {
    const names = Object.keys(o[h]).sort();
    if (names.length) parts.push(`${h}: ${names.join(", ")}`);
  }
  return parts.join("; ");
}
