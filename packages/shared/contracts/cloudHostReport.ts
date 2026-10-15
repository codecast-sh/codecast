/**
 * What the app shows about a cloud host, from the two machines that know it.
 * Pure data; no runtime imports.
 *
 * - HostReadiness: the host's own view, from files on its disk (its mirror
 *   stamp, host tools report, host setup outcome, the logins it holds). Rides
 *   the host's heartbeat onto its device row (devices.host_readiness), only
 *   when it changed.
 * - CloudHostReport: the managing laptop's view, from its host registry and
 *   AWS (awake or asleep, instance, cost, saved images, logins it held back,
 *   the last action the web asked for). The laptop writes it onto the host's
 *   device row (devices.cloud_host).
 */

export interface HostReadiness {
  mirror?: { complete: boolean; files: number; applied_at?: string; host_edited: string[] };
  tools?: { ok: number; installed: number; missing: Array<{ tool: string; referenced_by?: string }>; at?: string };
  setup?: { ok: boolean; applied_at?: string; step?: string; error?: string; at?: string; packages?: string[]; services?: string[]; commands?: number };
  /** Login files present on the host that a laptop pushed (agent-auth-origin.json), as tool ids. */
  logins?: string[];
  cast_version?: string;
  at: number;
}

export const CLOUD_HOST_ACTIONS = ["wake", "sleep", "setup", "image", "delete_image", "clone"] as const;

/**
 * The sizes the app offers for a new Linux host (the `clone` action: another
 * host like this one), with their on-demand rate in us-west-2. The CLI's
 * price table includes these, so the confirm screen and `cast hosts ls`
 * quote the same number.
 */
export const CLOUD_HOST_SIZES = [
  { type: "t3.large", vcpu: 2, memory_gb: 8, hourly_usd: 0.0832 },
  { type: "t3.xlarge", vcpu: 4, memory_gb: 16, hourly_usd: 0.1664 },
  { type: "t3.2xlarge", vcpu: 8, memory_gb: 32, hourly_usd: 0.3328 },
] as const;
export type CloudHostSize = (typeof CLOUD_HOST_SIZES)[number]["type"];
export const isCloudHostSize = (t: unknown): t is CloudHostSize => CLOUD_HOST_SIZES.some((s) => s.type === t);

/**
 * Autoscale, set on a Linux host (its template): when no awake host has room
 * for a new cloud session, the preparing laptop first wakes a sleeping host,
 * then launches another like the template, up to `max_extra` hosts it added.
 * Added hosts sleep on their own after the idle watchdog's minutes, so the
 * standing cost of an idle fleet is disk. Lives on the template's device row
 * (devices.cloud_autoscale); the laptop reads it at placement time.
 */
export interface CloudAutoscale {
  enabled: boolean;
  max_extra: number;
  size: CloudHostSize;
  at: number;
}
export const CLOUD_AUTOSCALE_MAX_EXTRA_CHOICES = [1, 2, 3] as const;
export const CLOUD_AUTOSCALE_DEFAULT_SIZE: CloudHostSize = "t3.xlarge";
export type CloudHostAction = (typeof CLOUD_HOST_ACTIONS)[number];

export interface CloudHostReport {
  /** The laptop that manages the host (its registry holds the key) and runs the web's actions. */
  managed_by: string;
  instance_id: string;
  provider: "aws" | "scaleway-mac";
  region?: string;
  instance_type?: string;
  state: "running" | "stopped" | "pending" | "stopping" | "missing" | "unknown";
  hourly_usd?: number;
  disk_monthly_usd?: number;
  disk_gib?: number;
  idle_stop_minutes?: number;
  images: Array<{ id: string; name: string; created: string }>;
  /** Logins the laptop has but did not push, with why (a lapsed token, laptop paths). */
  logins_held: Array<{ id: string; reason: string }>;
  last_action?: { action: CloudHostAction; status: "running" | "ok" | "failed"; detail?: string; at: number };
  /** Launched by autoscale (it counts against a template's max_extra). */
  autoscaled?: boolean;
  at: number;
}

/** The login file on the host → the tool it belongs to (for HostReadiness.logins). */
export function loginIdForHostPath(p: string): string {
  const rules: Array<[RegExp, string]> = [
    [/\.codex\/auth\.json$/, "codex"], [/\.grok\/auth\.json$/, "grok"], [/\.gemini\/oauth_creds\.json$/, "gemini"],
    [/opencode\/auth\.json$/, "opencode"], [/\.pi\/agent\/auth\.json$/, "pi"], [/gh\/hosts\.yml$/, "gh"],
    [/cloudflare\/config/, "cloudflare"], [/\.wrangler\//, "wrangler"], [/\.convex\//, "convex"], [/\.aws\//, "aws"],
    [/\.railway\//, "railway"], [/\.fly\//, "fly"], [/com\.vercel\.cli/, "vercel"], [/netlify/, "netlify"],
    [/\.supabase\//, "supabase"], [/stripe/, "stripe"], [/\.expo\//, "expo"], [/\.kube\//, "kube"], [/\.npmrc$/, "npm"],
    [/\.netrc$/, "netrc"], [/\.pgpass$/, "pgpass"], [/\.git-credentials$/, "git-credentials"], [/gcloud\//, "gcloud"],
  ];
  return rules.find(([re]) => re.test(p))?.[1] ?? p.replace(/^~\//, "");
}

/** The host's whole-screen VNC client (noVNC through websockify), on the host's loopback. */
export const HOST_NOVNC_PORT = 6080;

/** noVNC's page at a local port that reaches HOST_NOVNC_PORT: connects at once, scaled to fit. */
export function hostScreenUrl(localPort: number): string {
  return `http://127.0.0.1:${localPort}/vnc.html?autoconnect=1&resize=scale&path=`;
}
