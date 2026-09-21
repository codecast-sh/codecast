// The hire form's output (org-hire.md H3): one proposal spec, one ask, from a
// template's manifest and a person's answers. Pure, so it is tested without a
// DOM and the dialog only renders what it returns.
import { inputTokens, substitute, type OrgTemplate, type TemplateInput } from "@codecast/shared/contracts/orgTemplateManifest";
import type { OrgAuthorityGrant, OrgChange } from "@codecast/shared/contracts/orgProposal";

export type HireDraft = {
  template: { template_id: string; name: string; description: string; latest: { version: string; digest: string }; manifest: OrgTemplate } | null;
  project: { _id: string; short_id?: string; title: string } | null;
  instance: string;
  /** Answers by input key; secrets never appear here. */
  config: Record<string, string>;
  /** "me", or "@handle" of the project's lead to hire under (H3). */
  reportsTo: string;
  /** Name an existing role as the seat instead of hiring a new one (H3): its handle. */
  seatHandle: string | null;
  updatePolicy: "manual" | "canary" | "stable";
};

export type HireSpec = { title: string; summary_md: string; mode: "request"; changes: OrgChange[]; asks: { title: string; why: string; effect: string; seqs: number[] }[] };

export const SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 48);

/** The inputs a person answers in the form: everything but secrets, which bind on the host. */
export const askedInputs = (m: OrgTemplate): TemplateInput[] => (m.inputs ?? []).filter((i) => i.kind !== "secret");
export const secretInputs = (m: OrgTemplate): TemplateInput[] => (m.inputs ?? []).filter((i) => i.kind === "secret");

/** Why the draft cannot be posted yet, in the order the form shows them; empty when it can. */
export function hireErrors(d: HireDraft): string[] {
  const errors: string[] = [];
  if (!d.template) errors.push("Choose a template");
  if (!d.project) errors.push("Choose a project");
  if (!SLUG_RE.test(d.instance)) errors.push("The instance name is a lowercase slug (a letter, then letters, digits or dashes)");
  if (d.template) for (const input of askedInputs(d.template.manifest)) {
    const value = d.config[input.key];
    if (input.required && input.default === undefined && !(value ?? "").trim()) errors.push(`${input.label} is required`);
    if (value !== undefined && value !== "") {
      if ((input.kind === "number" || input.kind === "money") && !/^-?\d+(\.\d+)?$/.test(value)) errors.push(`${input.label} is a number`);
      if (input.kind === "money" && Number(value) < 0) errors.push(`${input.label} is not negative`);
      if (input.kind === "choice" && !(input.choices ?? []).includes(value)) errors.push(`${input.label} is one of ${(input.choices ?? []).join(", ")}`);
    }
  }
  if (d.reportsTo !== "me" && !/^@[a-z0-9-]{2,32}$/.test(d.reportsTo)) errors.push("Reports to is me or a role's @handle");
  return errors;
}

/** Answers with defaults filled, as the hire change carries them. */
export function resolvedConfig(m: OrgTemplate, config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of askedInputs(m)) {
    const value = config[input.key];
    if (value !== undefined && value !== "") out[input.key] = value;
    else if (input.default !== undefined) out[input.key] = String(input.default);
  }
  return out;
}

function tokenValues(m: OrgTemplate, d: HireDraft, config: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = { instance: d.instance, "project.ref": d.project?.short_id ?? d.project?._id ?? "", "project.name": d.project?.title ?? "", "project.dir": "", "template.root": "", "instance.file": "" };
  for (const input of m.inputs ?? []) values[`input.${input.key}`] = config[input.key] ?? "";
  return values;
}

/** The authority the hire asks for now: grants whose answered inputs are all in; a grant that
 *  waits on a secret still asks now, since nothing can act until the host binds it. */
export function grantsToAsk(m: OrgTemplate, config: Record<string, string>): OrgAuthorityGrant[] {
  const secrets = new Set(secretInputs(m).map((i) => i.key));
  const out: OrgAuthorityGrant[] = [];
  for (const g of m.authority ?? []) {
    if ((g.requires ?? []).some((key) => !secrets.has(key) && !(config[key] ?? "").trim())) continue;
    const limit: Record<string, number> = {};
    for (const [k, bound] of Object.entries(g.limit ?? {})) {
      const n = typeof bound === "number" ? bound : Number(config[String(bound).replace(/^\{\{input\.|\}\}$/g, "")]);
      if (Number.isFinite(n)) limit[k] = n;
    }
    out.push({ id: g.id, kind: g.kind, label: g.label, ...(g.scope ? { scope: g.scope } : {}), ...(Object.keys(limit).length ? { limit } : {}), ...(g.expires ? { expires: g.expires } : {}) });
  }
  return out;
}

export function buildHireSpec(d: HireDraft): HireSpec {
  const errors = hireErrors(d);
  if (errors.length || !d.template || !d.project) throw new Error(errors[0] ?? "Incomplete hire");
  const m = d.template.manifest;
  const config = resolvedConfig(m, d.config);
  const values = tokenValues(m, d, config);
  const tokens = inputTokens(m);
  const sub = (text: string) => substitute(text, values, tokens);
  const ref = d.project.short_id ?? d.project._id;
  const handle = d.seatHandle ?? sub(m.role.handle);
  const changes: OrgChange[] = [];
  if (!d.seatHandle) {
    changes.push({
      kind: "role", name: sub(m.role.name), handle, scope: { projects: [ref], plans: [] }, reports_to: d.reportsTo, trust: "understand", caps: m.role.caps,
      ...(m.role.avatar ? { avatar: m.role.avatar } : {}),
      ...(m.role.tenure ? { tenure: m.role.tenure.kind === "standing" ? { kind: "standing" as const } : { kind: "program" as const, ends: { project: ref }, then: m.role.tenure.then } } : {}),
      charter: `Hired from the template ${m.id} ${m.version}. Its charter, routines and skills load from the pinned release on the host: cast org template instructions ${d.instance} charter.`,
      evidence: [`Template ${m.id}@${m.version} sha256:${d.template.latest.digest.slice(0, 12)}`, `Project ${d.project.title}`],
    } as OrgChange);
  }
  const authority = grantsToAsk(m, config);
  if (authority.length) changes.push({ kind: "authority", handle, authority: authority.map((g) => ({ ...g, label: sub(g.label), ...(g.scope ? { scope: sub(g.scope) } : {}) })) });
  changes.push({ kind: "hire", handle, template: m.id, version: m.version, digest: d.template.latest.digest, instance: d.instance, project: ref, config, update_policy: d.updatePolicy });
  const routines = m.routines.map((r) => `${sub(r.title)} every ${r.every}${r.mode === "apply" ? " (acts, once its requirements hold)" : ""}`);
  const setup = (m.setup ?? []).filter((s) => s.who === "human");
  const summary = [
    `${d.template.name} on ${d.project.title}, from the template ${m.id} ${m.version}.`, "",
    m.description, "",
    d.seatHandle ? `@${d.seatHandle} is the seat: no new role.` : `A new role @${handle} at understand trust, reporting to ${d.reportsTo}, leads ${d.project.title}${d.reportsTo !== "me" ? ` under ${d.reportsTo}` : ""}.`,
    routines.length ? `Routines, created paused for you to activate one by one: ${routines.join("; ")}.` : "",
    authority.length ? `Authority asked for now: ${authority.map((g) => `${g.kind} (${g.label})`).join("; ")}.` : "No authority outside codecast is asked for.",
    setup.length ? `${setup.length} setup step${setup.length === 1 ? "" : "s"} only you can do; the role puts one in front of you at a time.` : "",
    `After you accept, run cast org template bind ${d.instance} in the project's checkout.`,
  ].filter((l) => l !== "").join("\n");
  return {
    title: `Hire ${d.template.name} on ${d.project.title}`, summary_md: summary, mode: "request", changes,
    asks: [{ title: `Hire ${d.template.name} on ${d.project.title}`, why: m.description, effect: d.seatHandle ? `@${d.seatHandle} takes the template's routines and record on ${d.project.title}` : `@${handle} leads ${d.project.title} and works within what you grant`, seqs: changes.map((_, i) => i + 1) }],
  };
}
