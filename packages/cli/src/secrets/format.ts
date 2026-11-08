// How `cast vault` prints a secret: its list row, its show page and its
// earlier values. Pure over the metadata the server returns; command.ts reads
// and registers.
import { ago, until } from "../externalDataCli.js";
import { fmt } from "../colors.js";
import { envFor, isExpiring, secretHealth, type SecretHealth, type SecretMeta, type SecretVersionMeta } from "@codecast/shared/contracts/secrets";
import { gapLine, type VaultMap } from "./projectMap.js";

const session = (id: string | undefined) => (id ? id.slice(0, 7) : undefined);

/** A sign-in's sites, else the env vars a secret fills under run (envFor); the ones only its name implies are muted. */
function bindingOf(s: SecretMeta): string {
  if (s.kind === "signin") return s.sites?.join(",") ?? "";
  const vars = envFor(s).map((b) => b.var).join(",");
  return s.env?.length ? vars : fmt.muted(vars);
}

const HEALTH_WORD: Record<SecretHealth, string> = { expired: "expired", expiring: "expiring", stale: "stale", unused: "never used" };

/** A ready secret's health as one short token, colored by urgency; "" when nothing needs a look. */
export function healthToken(s: SecretMeta, now: number = Date.now()): string {
  const h = secretHealth(s, now);
  if (!h) return "";
  const word = h === "expiring" ? `expiring ${until(s.signin_expires_at!, now)}` : HEALTH_WORD[h];
  return h === "expired" ? fmt.error(word) : fmt.warning(word);
}

/** A ready row's flags after its binding: Ask first, and the earlier values restore can put back. */
function markers(s: SecretMeta): string[] {
  return [s.ask_first ? fmt.warning("ask-first") : "", s.version_count ? fmt.muted(`${s.version_count} earlier`) : ""];
}

const kindText = (s: SecretMeta) => `${s.kind}${s.has_otp ? "+2fa" : ""}`;

/** One list row; `projectVars` are the env vars this checkout's [vault] fills from it. */
export function formatSecretLine(s: SecretMeta, scope: string, now: number = Date.now(), projectVars?: string[]): string {
  const project = projectVars?.length ? fmt.highlight(`project ${projectVars.join(",")}`) : "";
  if (s.status === "requested") {
    const who = s.requested_by_name ? ` by ${s.requested_by_name}` : "";
    const from = s.requested_from_conversation ? ` from ${session(s.requested_from_conversation)}` : "";
    return [fmt.id(s.short_id), fmt.warning("requested"), s.name, s.kind, bindingOf(s), project, fmt.muted(scope), fmt.muted(`asked${who}${from}${s.request_why ? `: ${s.request_why}` : ""}`)].filter(Boolean).join("  ");
  }
  const health = healthToken(s, now);
  const used = s.last_used_at ? `used ${ago(s.last_used_at, now)}${s.last_used_by_conversation ? ` by ${session(s.last_used_by_conversation)}` : ""}` : secretHealth(s, now) === "unused" ? "" : "never used";
  return [fmt.id(s.short_id), s.name, kindText(s), bindingOf(s), project, fmt.muted(scope), ...markers(s), health, used && fmt.muted(used)].filter(Boolean).join("  ");
}

/** The [vault] lines naming a secret the Vault does not hold, each with the request that fixes it; a required one (which stops run and cast dev) says so. */
export function unmappedLines(map: VaultMap, rows: Pick<SecretMeta, "name">[]): string[] {
  const held = new Set(rows.map((r) => r.name));
  return Object.entries(map).filter(([, b]) => !held.has(b.secret)).map(([v, b]) => fmt.warning(`${gapLine(v, b.secret, null)}${b.required ? " (required)" : ""}`));
}

export type SecretEvent = { kind: string; at: number; purpose?: string; actor_name?: string; session_short_id?: string; session_title?: string; decision_short_id?: string };

export function formatShow(s: SecretMeta, scope: string, events: SecretEvent[], now: number = Date.now()): string {
  const row = (label: string, value: string | undefined) => (value ? `  ${fmt.label(label.padEnd(12))}${value}` : null);
  const lines = [
    `${fmt.id(s.short_id)}  ${fmt.highlight(s.name)}  ${kindText(s)}  ${fmt.muted(scope)}${s.status === "requested" ? `  ${fmt.warning("requested")}` : ""}`,
    row("health", healthToken(s, now) || undefined),
    row("ask first", s.ask_first ? `on  ${fmt.muted("a person approves each session's first read")}` : undefined),
    row("env", s.kind === "signin" ? undefined : `${envFor(s).map((b) => b.var).join(", ")}${s.env?.length ? "" : `  ${fmt.muted("from its name")}`}`),
    row("sites", s.sites?.join(", ")),
    row("expires", s.kind === "signin" ? signinExpiry(s.signin_expires_at, now) : undefined),
    row("fingerprint", s.fingerprint),
    row("2fa", s.has_otp ? `seed stored  ${fmt.muted(`cast vault otp ${s.name}`)}` : undefined),
    row("earlier", s.version_count ? `${s.version_count} value${s.version_count === 1 ? "" : "s"}  ${fmt.muted(`cast vault restore ${s.name} lists them`)}` : undefined),
    row("note", s.note),
    row("asked", s.status === "requested" ? `${s.requested_by_name ?? "someone"}${s.request_why ? `: ${s.request_why}` : ""}` : undefined),
    row("created", `${ago(s.created_at, now)}${s.created_by_name ? ` by ${s.created_by_name}` : ""}${s.rotated_at ? `, rotated ${ago(s.rotated_at, now)}${s.updated_by_name ? ` by ${s.updated_by_name}` : ""}` : ""}`),
    row("used", s.last_used_at ? `${s.use_count ?? 0}x, last ${ago(s.last_used_at, now)}${s.last_used_by_conversation ? ` by ${session(s.last_used_by_conversation)}` : ""}` : "never"),
  ].filter((l): l is string => l !== null);
  if (events.length) {
    lines.push("", fmt.label("activity"));
    for (const e of events.slice(0, 15)) {
      const what = e.purpose ? `${e.kind} (${e.purpose})` : e.kind;
      const where = [e.decision_short_id, e.session_short_id && `${e.session_short_id}${e.session_title ? ` ${fmt.muted(e.session_title)}` : ""}`].filter(Boolean).map((w) => `  ${w}`).join("");
      lines.push(`  ${fmt.muted(ago(e.at, now).padEnd(10))}${what.padEnd(16)} ${e.actor_name ?? ""}${where}`);
    }
  }
  return lines.join("\n");
}

/** When a sign-in's cookies run out, as `show` says it. */
function signinExpiry(at: number | undefined, now: number): string {
  if (at === undefined) return "when the browser closes";
  const date = new Date(at).toISOString().slice(0, 10);
  if (at <= now) return fmt.warning(`expired ${ago(at, now)} (${date}): save it again with cast vault save-signin`);
  const left = `${until(at, now)} (${date})`;
  return isExpiring(at, now) ? fmt.warning(left) : left;
}

/** `restore`'s list: number (1 the newest), when and by whom it was replaced, its fingerprint, how long it stays. */
export function formatVersions(name: string, versions: SecretVersionMeta[], now: number = Date.now()): string {
  const lines = versions.map((v, i) =>
    [fmt.id(String(i + 1).padStart(2)), `replaced ${ago(v.rotated_at, now)}${v.rotated_by_name ? ` by ${v.rotated_by_name}` : ""}`, v.fingerprint ?? "", fmt.muted(`kept ${until(v.expires_at, now)}`)].filter(Boolean).join("  "),
  );
  return [...lines, fmt.muted(`Put one back: cast vault restore ${name} <number>`)].join("\n");
}

/** The version a restore argument names: its list number (1 the newest), its rotated_at, or its id. */
export function pickVersion(versions: SecretVersionMeta[], arg: string): SecretVersionMeta | undefined {
  const n = Number(arg);
  if (Number.isInteger(n) && n >= 1 && n <= versions.length) return versions[n - 1];
  return versions.find((v) => v._id === arg || String(v.rotated_at) === arg);
}
