// What the hire gallery says about a catalog template (org-hire.md H3), pure
// so the gallery's honesty rules are tested without a DOM: whether a card may
// offer the hire, a routine's title before any answer exists, and its cadence
// in words.
import type { OrgTemplate } from "@codecast/shared/contracts/orgTemplateManifest";

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
