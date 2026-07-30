// Stable-context contract: the structured record of the feed injected into a
// session at start (the <stable-context> block built from `cast feed`), plus
// the per-session launch overrides that adjust it. Shared by the CLI (which
// builds + records the context), the Convex backend (which stores it on the
// conversation), and the web (which renders it as cards and sends overrides
// from the new-session page).
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon,
// and the browser.

import type { StableMode } from "./snippets";

/** A mode that actually injects — the stored record can never be "off". */
export type StableFeedMode = Exclude<StableMode, "off">;

/** One feed card recorded at injection time. `id` is the Convex conversation
 * id (its first 7 chars are the session short id). Everything else is a
 * display snapshot — the web prefers the live store row when it has one. */
export interface StableContextItem {
  id: string;
  title: string;
  project_path?: string | null;
  updated_at?: string;
  message_count?: number;
  work_state?: string;
  is_live?: boolean;
  user_name?: string | null;
  owner_name?: string | null;
  owned_by_me?: boolean;
}

/** The JSON stored in conversations.stable_context. */
export interface StableContextData {
  mode: StableFeedMode;
  global?: boolean;
  injected_at: number;
  items: StableContextItem[];
}

/** Per-session launch prefs chosen on the new-session page. Ride the
 * createSession dispatch → enqueueStartSession args → daemon env, exactly
 * like model/effort. Old daemons ignore unknown args. */
export interface StableLaunchPrefs {
  stable_mode?: StableMode;
  stable_exclude?: string[];
}

// Env vars the daemon sets on a spawned agent process so the SessionStart
// hook (`cast stable-context`) can honor per-session choices and record
// against the right conversation without any lookup race.
export const STABLE_ENV_MODE = "CODECAST_STABLE_MODE";
export const STABLE_ENV_GLOBAL = "CODECAST_STABLE_GLOBAL";
export const STABLE_ENV_EXCLUDE = "CODECAST_STABLE_EXCLUDE";
export const STABLE_ENV_CONVERSATION_ID = "CODECAST_CONVERSATION_ID";

export interface ResolvedStableLaunch {
  /** null = injection disabled (no configured mode, or explicit "off"). */
  mode: StableFeedMode | null;
  global: boolean;
  exclude: string[];
  conversationId?: string;
}

/** Resolve what to inject for one session: env overrides (set by the daemon
 * from the web's per-session choice) win over the machine's config defaults. */
export function resolveStableLaunch(
  env: Record<string, string | undefined>,
  config: { stable_mode?: StableMode; stable_global?: boolean },
): ResolvedStableLaunch {
  const envMode = env[STABLE_ENV_MODE];
  let mode: StableFeedMode | null;
  if (envMode === "off") mode = null;
  else if (envMode === "team" || envMode === "solo") mode = envMode;
  else mode = config.stable_mode === "team" || config.stable_mode === "solo" ? config.stable_mode : null;

  const envGlobal = env[STABLE_ENV_GLOBAL];
  const global = envGlobal != null ? envGlobal === "1" || envGlobal === "true" : !!config.stable_global;

  const exclude = (env[STABLE_ENV_EXCLUDE] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const conversationId = env[STABLE_ENV_CONVERSATION_ID] || undefined;
  return { mode, global, exclude, conversationId };
}

/** Safe parse of conversations.stable_context. Returns null on anything that
 * isn't a well-formed record so renderers can just bail. */
export function parseStableContext(json: string | null | undefined): StableContextData | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.mode !== "team" && parsed.mode !== "solo") return null;
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter(
      (it: unknown): it is StableContextItem =>
        !!it && typeof it === "object" && typeof (it as any).id === "string" && typeof (it as any).title === "string",
    );
    return { mode: parsed.mode, global: !!parsed.global, injected_at: Number(parsed.injected_at) || 0, items };
  } catch {
    return null;
  }
}

/** Should this feed item be dropped from injection? Excludes match the full
 * conversation id or its 7-char short-id prefix. */
export function isExcludedStableItem(id: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const short = id.slice(0, 7).toLowerCase();
  return exclude.some((e) => {
    const norm = e.toLowerCase();
    return norm === id.toLowerCase() || norm === short || id.toLowerCase().startsWith(norm);
  });
}
