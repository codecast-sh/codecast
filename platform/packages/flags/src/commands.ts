// CLI verbs as plain functions: list, get and set catalog gates for a scope,
// and read PostHog flags for a distinct id. The app supplies the gate store
// (its own API calls), an optional PostHog client factory, and a writer. Mount
// them under any command framework, or run src/cli.ts directly.
import {
  type FeatureCatalog,
  type FeatureDescriptor,
  type StoredFlags,
  isEnabled,
} from "./catalog";
import type { FlagsClient } from "./posthog/types";

export interface GateStore<K extends string> {
  load: (scope: string) => Promise<StoredFlags<K> | null | undefined>;
  save: (scope: string, key: K, enabled: boolean) => Promise<void>;
}

export interface FlagsCommandDeps<K extends string> {
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>;
  gates: GateStore<K>;
  /** A PostHog client for one distinct id. Absent: the posthog verb errors. */
  posthog?: (distinctId: string) => FlagsClient;
  write: (line: string) => void;
  writeError: (line: string) => void;
}

export interface FlagsCommands<K extends string> {
  list: (scope: string) => Promise<void>;
  get: (scope: string, key: string) => Promise<void>;
  set: (scope: string, key: string, value: string) => Promise<void>;
  posthog: (distinctId: string, key?: string) => Promise<void>;
  /** Dispatch argv: `list <scope>`, `get <scope> <key>`, `set <scope> <key> on|off`,
   *  `posthog <distinctId> [key]`. Returns the exit code. */
  run: (argv: string[]) => Promise<number>;
}

export function parseOnOff(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled"].includes(v)) return true;
  if (["off", "false", "0", "no", "disable", "disabled"].includes(v)) return false;
  return null;
}

export const USAGE = [
  "flags list <scope>                 gates and their state for a scope",
  "flags get <scope> <key>            one gate",
  "flags set <scope> <key> on|off     flip a gate (admin)",
  "flags posthog <distinctId> [key]   PostHog flags as evaluated for an id",
].join("\n");

export function createFlagsCommands<K extends string>(deps: FlagsCommandDeps<K>): FlagsCommands<K> {
  const { catalog, gates, write, writeError } = deps;
  const fmt = (on: boolean) => (on ? "on" : "off");
  const badKey = (key: string) => {
    writeError(`Unknown feature: ${key}. Known: ${catalog.keys.join(", ")}`);
  };

  const list: FlagsCommands<K>["list"] = async (scope) => {
    const stored = await gates.load(scope);
    const width = Math.max(...catalog.keys.map((k) => k.length), 3);
    for (const f of catalog.features) {
      const on = isEnabled(catalog, stored, f.key);
      const source = typeof stored?.[f.key] === "boolean" ? "" : " (default)";
      write(`${f.key.padEnd(width)}  ${fmt(on)}${source}  ${f.name}`);
    }
  };

  const get: FlagsCommands<K>["get"] = async (scope, key) => {
    if (!catalog.isKey(key)) return badKey(key);
    write(fmt(isEnabled(catalog, await gates.load(scope), key)));
  };

  const set: FlagsCommands<K>["set"] = async (scope, key, value) => {
    if (!catalog.isKey(key)) return badKey(key);
    const enabled = parseOnOff(value);
    if (enabled === null) return writeError(`Expected on or off, got: ${value}`);
    await gates.save(scope, key, enabled);
    write(`${key} ${fmt(enabled)} for ${scope}`);
  };

  const posthog: FlagsCommands<K>["posthog"] = async (distinctId, key) => {
    if (!deps.posthog) return writeError("PostHog is not configured.");
    const client = deps.posthog(distinctId);
    await client.reload();
    const show = (k: string) => {
      const variant = client.getVariant(k);
      const payload = client.getPayload(k);
      const state = variant ?? fmt(client.getFlag(k));
      write(`${k}  ${state}${payload !== undefined ? `  ${JSON.stringify(payload)}` : ""}`);
    };
    if (key) return show(key);
    const snap = (client as { snapshot?: () => { values: Record<string, unknown> } }).snapshot?.();
    if (!snap) return writeError("This client cannot list flags; pass a key.");
    const keys = Object.keys(snap.values).sort();
    if (keys.length === 0) return write("(no flags)");
    for (const k of keys) show(k);
  };

  const run: FlagsCommands<K>["run"] = async (argv) => {
    const [verb, a, b, c] = argv;
    const need = (n: number) => {
      if (argv.length - 1 < n) {
        writeError(USAGE);
        return false;
      }
      return true;
    };
    switch (verb) {
      case "list":
        if (!need(1)) return 1;
        await list(a);
        return 0;
      case "get":
        if (!need(2)) return 1;
        await get(a, b);
        return 0;
      case "set":
        if (!need(3)) return 1;
        await set(a, b, c);
        return 0;
      case "posthog":
        if (!need(1)) return 1;
        await posthog(a, b);
        return 0;
      default:
        writeError(USAGE);
        return 1;
    }
  };

  return { list, get, set, posthog, run };
}
