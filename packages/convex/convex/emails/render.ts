// Codecast's brand, bound to the shared transactional email renderer.
//
// The block DSL, the palette, the table-based HTML renderer and its plain-text
// twin now live in @platform/email — they were extracted from this file, and a
// golden test in that package proves the output for these brand values is byte
// identical to what this module used to produce. What stays here is codecast's
// configuration plus the surface the rest of convex/ imports.

import {
  createRenderer,
  type Brand,
  type EmailDef,
  type RenderOptions,
  type RenderedEmail,
} from "@platform/email";

export { escapeHtml, monoStack, palette } from "@platform/email";
export type { EmailBlock, EmailDef, RenderedEmail } from "@platform/email";

export const BRAND = {
  name: "Codecast",
  url: "https://codecast.sh",
  tagline: "Mission control for your coding agents",
  supportEmail: "support@codecast.sh",
} as const satisfies Brand;

/** The renderer bound to codecast's brand. Templates call this, never the raw one. */
export const renderEmail: (def: EmailDef, opts?: RenderOptions) => RenderedEmail =
  createRenderer(BRAND);
