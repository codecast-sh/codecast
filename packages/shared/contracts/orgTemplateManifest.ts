// The template manifest (docs/architecture/org-hire.md H2): its types, its
// validator and its tokens. Pure, so the CLI (inspect, install), the server
// (publish) and the web (the hire form) all read one definition. File handling
// for a release folder stays in packages/cli/src/orgTemplateArtifact.ts.

/** POSIX or Windows absolute, without node:path, so this module runs anywhere. */
const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
// Manifest v2 (docs/architecture/org-hire.md H2): everything v1 says plus what
// a hire needs from a person. Every v2 addition is optional; v1 manifests
// validate unchanged. Unknown keys are refused at every object, as in v1.
export type TemplateInputKind = "string" | "number" | "money" | "boolean" | "choice" | "project_ref" | "doc_ref" | "task_ref" | "secret";
export type TemplateInput = { key: string; label: string; kind: TemplateInputKind; required?: boolean; default?: string | number | boolean; help?: string; choices?: string[]; unlocks?: string[] };
export type TemplateAuthorityKind = "spend" | "publish" | "write" | "connect";
export type TemplateAuthorityLimit = { usd_per_month?: number | string; usd_per_day?: number | string; per_day?: number | string };
export type TemplateAuthority = { id: string; kind: TemplateAuthorityKind; label: string; scope?: string; limit?: TemplateAuthorityLimit; requires?: string[]; expires?: string };
export type TemplateSetupItem = { id: string; title: string; who: "human" | "role"; unlocks?: string[]; how?: string; price?: string };
export type TemplateEvidenceCheck = { id: string; title: string; max_age: string; required_for?: string[] };
export type TemplateLedger = { id: string; title: string };
export type TemplateScoreboardKey = { key: string; label: string };
export type TemplateRoutine = { id: string; title: string; every: string; prompt: string; mode?: "propose" | "apply"; requires?: { authority?: string[]; evidence?: string[] } };
export type TemplateTenure = { kind: "standing" } | { kind: "program"; then: "retire" | "review" };
export type OrgTemplate = {
  schemaVersion: 1 | 2;
  id: string;
  version: string;
  name: string;
  description: string;
  role: { name: string; handle: string; charter: string; caps: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number }; avatar?: string; tenure?: TemplateTenure };
  routines: TemplateRoutine[];
  inputs?: TemplateInput[];
  authority?: TemplateAuthority[];
  setup?: TemplateSetupItem[];
  evidence?: TemplateEvidenceCheck[];
  ledgers?: TemplateLedger[];
  scoreboard?: TemplateScoreboardKey[];
  learn?: { review: "codecast" | "publisher" };
  instance_file?: string;
};
const TOKENS = new Set(["instance", "project.ref", "project.name", "project.dir", "template.root", "instance.file"]);
const INPUT_KINDS = new Set<TemplateInputKind>(["string", "number", "money", "boolean", "choice", "project_ref", "doc_ref", "task_ref", "secret"]);
const AUTHORITY_KINDS = new Set<TemplateAuthorityKind>(["spend", "publish", "write", "connect"]);
export const templateSlug = (value: string) => /^[a-z][a-z0-9-]{0,47}$/.test(value);
/** Dotted input keys: `budget.monthly_envelope_usd`. */
export const inputKey = (value: string) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(value) && value.length <= 64;
/** The token an answered input substitutes as: `{{input.<key>}}`. */
export const inputToken = (key: string) => `input.${key}`;

/** Exact shape: every key in `keys` present, keys in `optional` allowed, nothing else. */
function object(value: unknown, keys: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !(key in row))) throw new Error(`${label} has missing or unknown fields`);
  return row;
}
function string(value: unknown, label: string, inputs?: Set<string>): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be nonempty text`);
  validateTokens(value, inputs);
}
/** A list of references to ids declared elsewhere in the manifest (already format-checked there). */
function slugList(value: unknown, label: string, known: Set<string>): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${label} must be an array of at most 50 ids`);
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || seen.has(id)) throw new Error(`${label} has an invalid or duplicate id`);
    if (!known.has(id)) throw new Error(`${label} references an unknown id: ${id}`);
    seen.add(id);
  }
  return value as string[];
}
/**
 * Tokens are the six instance values plus, when the manifest declares inputs,
 * `input.<key>` for each declared key. A token for an undeclared input is an
 * error at inspect time, never a blank at run time.
 */
export function validateTokens(text: string, inputs?: Set<string>): void {
  const rest = text.replace(/\{\{([^{}]+)\}\}/g, (_, token: string) => {
    if (TOKENS.has(token)) return "";
    if (token.startsWith("input.") && inputs?.has(token.slice("input.".length))) return "";
    throw new Error(`Unknown template token: ${token}`);
  });
  if (rest.includes("{{") || rest.includes("}}")) throw new Error("Malformed template token");
}
export function inputTokens(manifest: Pick<OrgTemplate, "inputs">): Set<string> {
  return new Set((manifest.inputs ?? []).map((input) => input.key));
}
export function substitute(text: string, values: Record<string, string>, inputs?: Set<string>): string {
  validateTokens(text, inputs);
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, token: string) => {
    if (!(token in values)) throw new Error(`Missing template value: ${token}`);
    return values[token];
  });
}
export function templatePath(value: string): string {
  if (!value || isAbsolutePath(value) || value.includes("\\") || value.includes("\0") || value.split("/").some((p) => !p || p === "." || p === "..") || value.includes("{{")) throw new Error(`Unsafe artifact path: ${value}`);
  return value;
}
export function intervalMs(every: string): number {
  const match = /^([1-9][0-9]*)(m|h|d|w)$/.exec(every);
  if (!match) throw new Error(`Invalid cadence: ${every}`);
  const value = Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]!);
  if (!Number.isSafeInteger(value) || value > 365 * 86400000) throw new Error(`Cadence exceeds one year: ${every}`);
  return value;
}
export function validateTemplate(value: unknown): OrgTemplate {
  const V2_KEYS = ["inputs", "authority", "setup", "evidence", "ledgers", "scoreboard", "learn", "instance_file"];
  const row = object(value, ["schemaVersion", "id", "version", "name", "description", "role", "routines"], "Template", V2_KEYS);
  if (row.schemaVersion !== 1 && row.schemaVersion !== 2) throw new Error("Unsupported template schemaVersion");
  const v2 = row.schemaVersion === 2;
  if (!v2 && V2_KEYS.some((key) => key in row)) throw new Error("Template has missing or unknown fields");

  // Inputs come first: every other string may reference them.
  const inputs = new Set<string>();
  if ("inputs" in row) {
    if (!Array.isArray(row.inputs) || row.inputs.length > 100) throw new Error("Inputs must be an array of at most 100 entries");
    for (const raw of row.inputs) {
      const input = object(raw, ["key", "label", "kind"], "Input", ["required", "default", "help", "choices", "unlocks"]);
      if (typeof input.key !== "string" || !inputKey(input.key) || inputs.has(input.key)) throw new Error("Invalid or duplicate input key");
      string(input.label, "input.label");
      if (!INPUT_KINDS.has(input.kind as TemplateInputKind)) throw new Error(`Unknown input kind: ${String(input.kind)}`);
      if ("required" in input && typeof input.required !== "boolean") throw new Error("input.required must be a boolean");
      if ("help" in input) string(input.help, "input.help");
      if ("default" in input) {
        if (input.kind === "secret") throw new Error("A secret input cannot carry a default");
        if (!["string", "number", "boolean"].includes(typeof input.default)) throw new Error("input.default must be a string, number or boolean");
        if (typeof input.default === "string") validateTokens(input.default);
      }
      if (input.kind === "choice") {
        if (!Array.isArray(input.choices) || !input.choices.length || input.choices.length > 50 || input.choices.some((c) => typeof c !== "string" || !c.trim())) throw new Error("A choice input needs choices");
        if ("default" in input && !(input.choices as string[]).includes(input.default as string)) throw new Error("input.default must be one of its choices");
      } else if ("choices" in input) throw new Error("Only a choice input has choices");
      inputs.add(input.key);
    }
  }

  for (const key of ["id", "version", "name", "description"]) string(row[key], key);
  if (!templateSlug(row.id as string) || !/^\d+\.\d+\.\d+$/.test(row.version as string)) throw new Error("Invalid template id or version");
  const role = object(row.role, ["name", "handle", "charter", "caps"], "Role", v2 ? ["avatar", "tenure"] : []);
  for (const key of ["name", "handle", "charter"]) string(role[key], `role.${key}`, inputs);
  templatePath(role.charter as string);
  const caps = object(role.caps, ["hands_per_day", "wakes_per_day", "tokens_per_day"], "Caps");
  for (const cap of Object.values(caps)) if (!Number.isSafeInteger(cap) || (cap as number) < 0) throw new Error("Caps must be nonnegative safe integers");
  if ("avatar" in role && (typeof role.avatar !== "string" || !templateSlug(role.avatar))) throw new Error("role.avatar must be an avatar key");
  if ("tenure" in role) {
    const tenure = object(role.tenure, ["kind"], "Tenure", ["then"]);
    if (tenure.kind === "standing") { if ("then" in tenure) throw new Error("A standing tenure has no then"); }
    else if (tenure.kind === "program") { if (!["retire", "review"].includes(tenure.then as string)) throw new Error("A program tenure needs then: retire or review"); }
    else throw new Error("tenure.kind must be standing or program");
  }

  if (!Array.isArray(row.routines) || row.routines.length > 50) throw new Error("Routines must be an array of at most 50 entries");
  const routineIds = new Set<string>();
  for (const raw of row.routines) {
    const routine = object(raw, ["id", "title", "every", "prompt"], "Routine", v2 ? ["mode", "requires"] : []);
    for (const key of ["id", "title", "every", "prompt"]) string(routine[key], `routine.${key}`, inputs);
    if (!templateSlug(routine.id as string) || routine.id === "charter" || routineIds.has(routine.id as string)) throw new Error("Invalid or duplicate routine id");
    routineIds.add(routine.id as string);
    intervalMs(routine.every as string);
    templatePath(routine.prompt as string);
    if ("mode" in routine && routine.mode !== "propose" && routine.mode !== "apply") throw new Error("routine.mode must be propose or apply");
  }

  // Authority (what the role may do outside codecast), then the references
  // that point at inputs, authority and routines.
  const grantIds = new Set<string>();
  if ("authority" in row) {
    if (!Array.isArray(row.authority) || row.authority.length > 50) throw new Error("Authority must be an array of at most 50 entries");
    for (const raw of row.authority) {
      const grant = object(raw, ["id", "kind", "label"], "Authority", ["scope", "limit", "requires", "expires"]);
      if (typeof grant.id !== "string" || !templateSlug(grant.id) || grantIds.has(grant.id)) throw new Error("Invalid or duplicate authority id");
      if (!AUTHORITY_KINDS.has(grant.kind as TemplateAuthorityKind)) throw new Error(`Unknown authority kind: ${String(grant.kind)}`);
      string(grant.label, "authority.label", inputs);
      if ("scope" in grant) string(grant.scope, "authority.scope", inputs);
      if ("limit" in grant) {
        const limit = object(grant.limit, [], "Authority limit", ["usd_per_month", "usd_per_day", "per_day"]);
        if (!Object.keys(limit).length) throw new Error("Authority limit must name at least one bound");
        for (const [key, bound] of Object.entries(limit)) {
          if (typeof bound === "number") { if (!Number.isFinite(bound) || bound < 0) throw new Error(`authority.limit.${key} must be nonnegative`); }
          else if (typeof bound === "string") {
            const match = /^\{\{input\.([^{}]+)\}\}$/.exec(bound);
            if (!match || !inputs.has(match[1]!)) throw new Error(`authority.limit.${key} must be a number or one input token`);
          } else throw new Error(`authority.limit.${key} must be a number or one input token`);
        }
      }
      if ("requires" in grant) slugList(grant.requires, "authority.requires", inputs);
      if ("expires" in grant) { if (typeof grant.expires !== "string") throw new Error("authority.expires must be a cadence"); intervalMs(grant.expires); }
      grantIds.add(grant.id);
    }
  }
  const unlockable = new Set([...routineIds, ...grantIds]);
  if ("inputs" in row) for (const input of row.inputs as Record<string, unknown>[]) if ("unlocks" in input) slugList(input.unlocks, "input.unlocks", unlockable);
  if ("setup" in row) {
    if (!Array.isArray(row.setup) || row.setup.length > 50) throw new Error("Setup must be an array of at most 50 entries");
    const ids = new Set<string>();
    for (const raw of row.setup) {
      const item = object(raw, ["id", "title", "who"], "Setup item", ["unlocks", "how", "price"]);
      if (typeof item.id !== "string" || !templateSlug(item.id) || ids.has(item.id)) throw new Error("Invalid or duplicate setup id");
      string(item.title, "setup.title", inputs);
      if (item.who !== "human" && item.who !== "role") throw new Error("setup.who must be human or role");
      if ("unlocks" in item) slugList(item.unlocks, "setup.unlocks", unlockable);
      if ("how" in item) { string(item.how, "setup.how"); templatePath(item.how); }
      if ("price" in item) string(item.price, "setup.price", inputs);
      ids.add(item.id);
    }
  }
  const evidenceIds = new Set<string>();
  if ("evidence" in row) {
    if (!Array.isArray(row.evidence) || row.evidence.length > 50) throw new Error("Evidence must be an array of at most 50 entries");
    for (const raw of row.evidence) {
      const check = object(raw, ["id", "title", "max_age"], "Evidence check", ["required_for"]);
      if (typeof check.id !== "string" || !inputKey(check.id) || evidenceIds.has(check.id)) throw new Error("Invalid or duplicate evidence id");
      string(check.title, "evidence.title", inputs);
      if (typeof check.max_age !== "string") throw new Error("evidence.max_age must be a cadence");
      intervalMs(check.max_age);
      if ("required_for" in check) slugList(check.required_for, "evidence.required_for", routineIds);
      evidenceIds.add(check.id);
    }
  }
  for (const raw of row.routines as Record<string, unknown>[]) {
    if (!("requires" in raw)) continue;
    const requires = object(raw.requires, [], "routine.requires", ["authority", "evidence"]);
    if ("authority" in requires) slugList(requires.authority, "routine.requires.authority", grantIds);
    if ("evidence" in requires) slugList(requires.evidence, "routine.requires.evidence", evidenceIds);
  }
  if ("ledgers" in row) {
    if (!Array.isArray(row.ledgers) || row.ledgers.length > 20) throw new Error("Ledgers must be an array of at most 20 entries");
    const ids = new Set<string>();
    for (const raw of row.ledgers) {
      const ledger = object(raw, ["id", "title"], "Ledger");
      if (typeof ledger.id !== "string" || !templateSlug(ledger.id) || ids.has(ledger.id)) throw new Error("Invalid or duplicate ledger id");
      string(ledger.title, "ledger.title", inputs);
      ids.add(ledger.id);
    }
  }
  if ("scoreboard" in row) {
    if (!Array.isArray(row.scoreboard) || row.scoreboard.length > 30) throw new Error("Scoreboard must be an array of at most 30 entries");
    const keys = new Set<string>();
    for (const raw of row.scoreboard) {
      const entry = object(raw, ["key", "label"], "Scoreboard entry");
      if (typeof entry.key !== "string" || !inputKey(entry.key) || keys.has(entry.key)) throw new Error("Invalid or duplicate scoreboard key");
      string(entry.label, "scoreboard.label");
      keys.add(entry.key);
    }
  }
  if ("learn" in row) {
    const learn = object(row.learn, ["review"], "Learn");
    if (learn.review !== "codecast" && learn.review !== "publisher") throw new Error("learn.review must be codecast or publisher");
  }
  if ("instance_file" in row) {
    string(row.instance_file, "instance_file");
    const file = row.instance_file as string;
    if (isAbsolutePath(file) || file.includes("\\") || file.split("/").some((p) => !p || p === "." || p === "..")) throw new Error(`Unsafe instance file: ${file}`);
  }
  return value as OrgTemplate;
}
/** Every file a manifest names inside the release: charter, routine prompts, setup how-tos. */
export function manifestFiles(manifest: OrgTemplate): string[] {
  return [manifest.role.charter, ...manifest.routines.map((r) => r.prompt), ...(manifest.setup ?? []).flatMap((s) => (s.how ? [s.how] : []))];
}
