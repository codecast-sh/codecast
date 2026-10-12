// What the hire gallery says about a catalog template (org-hire.md H3), pure
// so the gallery's honesty rules are tested without a DOM: whether a card may
// offer the hire, a routine's title before any answer exists, and its cadence
// in words.
import type { OrgTemplate } from "@codecast/shared/contracts/orgTemplateManifest";
import { EXECUTIVE_ASSISTANT_HANDLE, EXECUTIVE_ASSISTANT_NAME, HEAD_OF_PEOPLE_HANDLE, HEAD_OF_PEOPLE_NAME, isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";

/** A role codecast itself offers at the top of the gallery (org-staffing.md
 *  S6, S30): hired through its own path, never a template, and offered only
 *  while none stands. */
export type BuiltinHire = {
  id: "head-of-people" | "executive-assistant";
  name: string;
  handle: string;
  description: string;
  /** What it does, as the card's chips. */
  does: string[];
};

export const HEAD_OF_PEOPLE_HIRE: BuiltinHire = {
  id: "head-of-people",
  name: HEAD_OF_PEOPLE_NAME,
  handle: HEAD_OF_PEOPLE_HANDLE,
  description: "Keeps the structure true to how the work runs: who owns which area, who reports to whom, where each session belongs. Reviews the company weekly and proposes; a person decides.",
  does: ["Reviews the org weekly", "Proposes, never applies", "Looks after what no lead owns"],
};

export const EXECUTIVE_ASSISTANT_HIRE: BuiltinHire = {
  id: "executive-assistant",
  name: EXECUTIVE_ASSISTANT_NAME,
  handle: EXECUTIVE_ASSISTANT_HANDLE,
  description: "Your right hand: answers anything you ask about any part of the work, routes a request in a lead's area to that lead, and brings you decisions with a recommendation. Starts no work and reorganizes nothing.",
  does: ["Answers you about any area", "Routes requests to the lead", "Keeps your focus in view"],
};

/** The built-in hires this workspace can still make: each hidden once one
 *  stands. The Head of People is a role of this workspace; the Executive
 *  Assistant is the person's, read from the seats they can see. */
export function builtinHires(roles: ReadonlyArray<{ handle?: string; status?: string }>, standing: { assistant: boolean }): BuiltinHire[] {
  const head = roles.some((r) => r.status !== "retired" && isHeadOfPeopleRole(r));
  return [...(head ? [] : [HEAD_OF_PEOPLE_HIRE]), ...(standing.assistant ? [] : [EXECUTIVE_ASSISTANT_HIRE])];
}

export type CatalogTemplate = {
  template_id: string;
  workspace: string;
  name: string;
  description: string;
  avatar?: string;
  latest: { version: string; digest: string };
  latest_status?: "draft" | "canary" | "stable" | null;
  installable?: boolean;
  asks: { inputs: number; secrets: number; authority: number; setup: number; routines: number };
  manifest: OrgTemplate;
};

/** Why a card cannot offer the hire, in the words it shows; null when it can. */
export function cannotHireReason(t: CatalogTemplate, projectCount: number): string | null {
  if (!t.installable) return "Not ready to hire: its release was published without the files a machine installs. Publish it again.";
  if (projectCount === 0) return "Create a project in this workspace first: this role leads one project.";
  return null;
}

/** A manifest title for the gallery, before any answer exists: an input token reads as the input's label, the project and instance tokens as words. */
export function displayTitle(m: OrgTemplate, text: string): string {
  const labels = new Map((m.inputs ?? []).map((i) => [i.key, i.label]));
  return text.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_, token: string) => {
    if (token.startsWith("input.")) return labels.get(token.slice(6)) ?? "…";
    if (token === "project.name" || token === "project.ref") return "the project";
    if (token === "instance") return "the instance";
    return "…";
  });
}

/** The cadence of a routine in words: 1d → daily, 7d → weekly, 2d → every 2 days. */
export function cadenceWords(every: string): string {
  const m = /^(\d+)([mhd])$/.exec(every);
  if (!m) return `every ${every}`;
  const n = Number(m[1]);
  const unit = m[2] === "d" ? "day" : m[2] === "h" ? "hour" : "minute";
  if (unit === "day" && n === 1) return "daily";
  if (unit === "day" && n === 7) return "weekly";
  if (unit === "day" && n === 14) return "every two weeks";
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}
