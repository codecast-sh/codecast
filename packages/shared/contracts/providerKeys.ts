// The provider-key registry: one entry per LLM provider codecast can hold an API
// key for. It is the single source of truth shared by the daemon (which injects a
// managed key as the provider's env var when it launches a client), the CLI
// (`cast keys …`), and the web (Settings + the inline auth-card key entry).
//
// Design: codecast NEVER manages keys by default — a client uses whatever auth is
// already on the system (its own login, or an env var already set). A managed key
// is purely additive: if the user sets one, the daemon adds `ENVVAR=<key>` to the
// launch environment; opencode, pi, aider, and most clients read these standard
// env vars, so one injection point covers them all. Keys live on-device and sync
// device→device over the credential-push channel — never plaintext in Convex.

export interface ProviderKeySpec {
  /** Stable id — the CLI arg, the store key, the wire value. */
  id: string;
  /** Human name for the UI. */
  label: string;
  /** The environment variable(s) clients read this provider's key from. The first
   *  is canonical; extras are aliases some clients/SDKs use, all set to the same
   *  value so every client resolves the key regardless of which name it reads. */
  envVars: [string, ...string[]];
  /** Leading substring a valid key has, when the provider uses a stable prefix —
   *  powers a cheap format sanity-check and the input placeholder. Omitted when the
   *  provider has no consistent prefix. */
  keyPrefix?: string;
  /** Where the user creates/copies a key — shown as a "get a key" link. */
  consoleUrl: string;
}

// Ordered by how commonly codecast users reach for them. OpenRouter first: it is a
// single key that fronts every model, the usual answer to "the model won't run".
export const PROVIDER_KEYS: ProviderKeySpec[] = [
  { id: "openrouter", label: "OpenRouter", envVars: ["OPENROUTER_API_KEY"], keyPrefix: "sk-or-", consoleUrl: "https://openrouter.ai/keys" },
  { id: "anthropic", label: "Anthropic", envVars: ["ANTHROPIC_API_KEY"], keyPrefix: "sk-ant-", consoleUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", envVars: ["OPENAI_API_KEY"], keyPrefix: "sk-", consoleUrl: "https://platform.openai.com/api-keys" },
  // opencode/pi read Gemini from GEMINI_API_KEY; the AI SDK also honors
  // GOOGLE_GENERATIVE_AI_API_KEY — set both so either resolves.
  { id: "google", label: "Google Gemini", envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], keyPrefix: "AIza", consoleUrl: "https://aistudio.google.com/apikey" },
  { id: "groq", label: "Groq", envVars: ["GROQ_API_KEY"], keyPrefix: "gsk_", consoleUrl: "https://console.groq.com/keys" },
  { id: "xai", label: "xAI", envVars: ["XAI_API_KEY"], keyPrefix: "xai-", consoleUrl: "https://console.x.ai" },
  { id: "deepseek", label: "DeepSeek", envVars: ["DEEPSEEK_API_KEY"], keyPrefix: "sk-", consoleUrl: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", label: "Mistral", envVars: ["MISTRAL_API_KEY"], consoleUrl: "https://console.mistral.ai/api-keys" },
];

const BY_ID = new Map(PROVIDER_KEYS.map((p) => [p.id, p]));
export function getProviderKeySpec(id: string): ProviderKeySpec | undefined {
  return BY_ID.get(id);
}

// A stored key set: provider id → key. This is the shape the on-device store holds
// and the daemon reads to build launch env. Empty (the default) = nothing injected.
export type ProviderKeyStore = Record<string, string>;

/** The launch env additions for a stored key set — every provider's env var(s)
 *  mapped to its key. The daemon prepends these to the launch command; an empty
 *  store yields `{}`, so the default "don't manage" path injects nothing. Unknown
 *  provider ids (a newer store read by an older binary) are skipped, not crashed. */
export function providerKeyEnv(store: ProviderKeyStore | undefined | null): Record<string, string> {
  const env: Record<string, string> = {};
  if (!store) return env;
  for (const [id, key] of Object.entries(store)) {
    if (!key) continue;
    const spec = BY_ID.get(id);
    if (!spec) continue;
    for (const envVar of spec.envVars) env[envVar] = key;
  }
  return env;
}

/** Mask a key for display/logs — first 6 and last 4, middle elided. Never render a
 *  full key in a UI or log line. */
export function maskProviderKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 2) + "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
