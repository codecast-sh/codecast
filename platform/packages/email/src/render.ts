// Transactional email renderer. Pure module, no framework imports, so
// templates render identically in a backend, in tests, and in a preview.
//
// Every email is defined as structured blocks (EmailDef) and rendered twice
// from that single source: once to table based HTML (email client safe), once
// to plain text. That guarantees the text part never drifts from the HTML.
//
// Client compat rules the HTML renderer follows:
// - Tables with role="presentation" for all layout; no flex/grid.
// - Every visual style inlined; the <style> tag only carries what inline CSS
//   cannot: dark mode media queries, the mobile breakpoint, and link hovers.
//   Clients that strip <style> (older Gmail IMAP views) still get the full
//   light mode design from the inline styles.
// - Dark mode targets both prefers-color-scheme and Outlook.com's [data-ogsc]
//   attribute rewriting.
// - The button uses the mso-text-raise faux padding trick so Outlook on
//   Windows renders a clickable area, not a thin line of text.
// - The logo is text (accent glyph + name), never an image.
//
// The brand (name, URL, colors, font) is injected: `createRenderer(brand)`
// returns a render function, or call `renderEmail(def, brand)` directly.
// Output for codecast's brand is byte identical to codecast's original
// renderer (see render.golden.test.ts).

import { type Brand, resolveBrand } from "./brand";

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

export type EmailBlock =
  /** Paragraph. `value` is plain text with **bold** and [label](url) markers. */
  | { kind: "text"; value: string }
  /** Large one time code with an expiry hint underneath. */
  | { kind: "code"; code: string; hint?: string }
  /** Primary call to action button. */
  | { kind: "button"; label: string; url: string }
  /** "Or paste this link" small print under a button. */
  | { kind: "linkFallback"; url: string }
  /** Label/value rows (security notices: account, time, device). */
  | { kind: "meta"; rows: Array<{ label: string; value: string }> }
  /** Dark terminal snippet. Lines with prompt=true get a green "$". */
  | { kind: "terminal"; lines: Array<{ text: string; prompt?: boolean; muted?: boolean }> }
  /** Quoted text with attribution (comment notifications). */
  | { kind: "quote"; value: string; by?: string }
  /**
   * One digest entry: bold title line (supports **bold** markers), optional
   * muted excerpt, and a link. Rendered as an accent edged row.
   */
  | { kind: "item"; title: string; excerpt?: string; url: string; linkLabel?: string }
  /** Muted small print inside the card (safe to ignore notes). */
  | { kind: "note"; value: string }
  /** Small uppercase section label (digest section headings). */
  | { kind: "subheading"; value: string }
  | { kind: "divider" };

export interface EmailDef {
  subject: string;
  /** Inbox preview line; hidden in the rendered body. */
  preheader: string;
  /** Small accent overline above the heading, e.g. "SECURITY". */
  eyebrow?: string;
  heading: string;
  blocks: EmailBlock[];
  /** Footer line: why the recipient got this email. Plain text + markers. */
  reason: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderOptions {
  /** Copyright year in the footer. Defaults to the current year. */
  year?: number;
}

export type RenderEmail = (def: EmailDef, opts?: RenderOptions) => RenderedEmail;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip markers for the plain text part; links become "label (url)". */
function inlineText(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, "$1 ($2)");
}

// ---------------------------------------------------------------------------
// Text block renderers (brand independent)
// ---------------------------------------------------------------------------

function renderBlockText(block: EmailBlock): string {
  switch (block.kind) {
    case "text":
      return inlineText(block.value);
    case "code":
      return `    ${block.code}${block.hint ? `\n    (${block.hint})` : ""}`;
    case "button":
      return `${block.label}:\n    ${block.url}`;
    case "linkFallback":
      return ""; // the button text form already carries the URL
    case "meta":
      return block.rows.map((r) => `    ${r.label}: ${r.value}`).join("\n");
    case "terminal":
      return block.lines.map((l) => `    ${l.prompt ? "$ " : ""}${l.text}`).join("\n");
    case "quote":
      return (
        block.value
          .split("\n")
          .map((l) => `    > ${l}`)
          .join("\n") + (block.by ? `\n    — ${block.by}` : "")
      );
    case "item":
      return `  * ${inlineText(block.title)}${block.excerpt ? `\n    ${block.excerpt.split("\n").join("\n    ")}` : ""}\n    ${block.url}`;
    case "note":
      return inlineText(block.value);
    case "subheading":
      return block.value.toUpperCase();
    case "divider":
      return "----";
  }
}

// ---------------------------------------------------------------------------
// Renderer factory
// ---------------------------------------------------------------------------

export function createRenderer(brandInput: Brand): RenderEmail {
  const brand = resolveBrand(brandInput);
  const palette = brand.palette;
  const monoStack = brand.fontStack;

  /**
   * Escape, then expand the two inline markers: **bold** and [label](url).
   * Marker expansion runs AFTER escaping, so user supplied text can never
   * inject markup; only the markers written by our own templates render.
   */
  function inlineHtml(value: string, linkColorClass = "em-link"): string {
    let out = escapeHtml(value);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(
      /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,
      (_m, label, url) =>
        `<a href="${url}" class="${linkColorClass}" style="color:${palette.accentDark};text-decoration:underline;">${label}</a>`,
    );
    return out;
  }

  const pStyle = `margin:0 0 16px 0;font-family:${monoStack};font-size:14px;line-height:1.7;color:${palette.text};`;
  const noteStyle = `margin:0 0 8px 0;font-family:${monoStack};font-size:12px;line-height:1.7;color:${palette.textMuted};`;

  function renderBlockHtml(block: EmailBlock): string {
    switch (block.kind) {
      case "text":
        return `<p class="em-text" style="${pStyle}">${inlineHtml(block.value)}</p>`;

      case "code":
        return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;">
  <tr>
    <td class="em-inset" align="center" style="background:${palette.insetBg};border:1px dashed ${palette.insetBorder};border-radius:10px;padding:22px 16px;">
      <div class="em-codechars" style="font-family:${monoStack};font-size:32px;font-weight:700;letter-spacing:10px;text-indent:10px;color:${palette.text};">${escapeHtml(block.code)}</div>
      ${block.hint ? `<div class="em-muted" style="margin-top:10px;font-family:${monoStack};font-size:12px;color:${palette.textMuted};">${escapeHtml(block.hint)}</div>` : ""}
    </td>
  </tr>
</table>`;

      case "button":
        // Faux padding via mso-text-raise + letter-spacing keeps the whole
        // button clickable in Outlook on Windows, which drops <a> padding.
        return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;">
  <tr>
    <td class="em-btn" style="background:${palette.accent};border-radius:10px;mso-padding-alt:14px 32px;">
      <a href="${escapeHtml(block.url)}" target="_blank" style="display:inline-block;padding:13px 32px;font-family:${monoStack};font-size:14px;font-weight:700;color:${palette.buttonText};text-decoration:none;border-radius:10px;">
        <!--[if mso]><i style="mso-font-width:320%;mso-text-raise:26pt" hidden>&nbsp;</i><![endif]-->
        <span style="mso-text-raise:13pt;">${escapeHtml(block.label)}&nbsp;&nbsp;&#8250;</span>
        <!--[if mso]><i style="mso-font-width:320%;" hidden>&nbsp;&nbsp;</i><![endif]-->
      </a>
    </td>
  </tr>
</table>`;

      case "linkFallback":
        return `<p class="em-muted" style="${noteStyle}margin-bottom:20px;word-break:break-all;">Button not working? Paste this into your browser:<br><a href="${escapeHtml(block.url)}" class="em-link" style="color:${palette.accentDark};text-decoration:underline;">${escapeHtml(block.url)}</a></p>`;

      case "meta":
        return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="em-inset" style="margin:8px 0 20px 0;background:${palette.insetBg};border:1px solid ${palette.insetBorder};border-radius:10px;">
  ${block.rows
    .map(
      (r, i) => `<tr>
    <td class="em-muted" style="padding:${i === 0 ? "14px" : "6px"} 0 ${i === block.rows.length - 1 ? "14px" : "6px"} 18px;font-family:${monoStack};font-size:12px;color:${palette.textMuted};white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
    <td class="em-text" width="100%" style="padding:${i === 0 ? "14px" : "6px"} 18px ${i === block.rows.length - 1 ? "14px" : "6px"} 16px;font-family:${monoStack};font-size:12px;font-weight:700;color:${palette.text};">${escapeHtml(r.value)}</td>
  </tr>`,
    )
    .join("")}
</table>`;

      case "terminal":
        return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;">
  <tr>
    <td style="background:${palette.termBg};border-radius:10px;padding:16px 18px;">
      ${block.lines
        .map((l) => {
          const color = l.muted ? palette.termMuted : palette.termText;
          const prompt = l.prompt
            ? `<span style="color:${palette.termPrompt};">$&nbsp;</span>`
            : "";
          return `<div style="font-family:${monoStack};font-size:13px;line-height:1.9;color:${color};white-space:pre-wrap;word-break:break-all;">${prompt}${escapeHtml(l.text)}</div>`;
        })
        .join("")}
    </td>
  </tr>
</table>`;

      case "quote":
        return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;">
  <tr>
    <td style="border-left:3px solid ${palette.accent};padding:2px 0 2px 16px;">
      <div class="em-text" style="font-family:${monoStack};font-size:14px;line-height:1.7;color:${palette.text};white-space:pre-wrap;">${escapeHtml(block.value)}</div>
      ${block.by ? `<div class="em-muted" style="margin-top:8px;font-family:${monoStack};font-size:12px;color:${palette.textMuted};">&mdash; ${escapeHtml(block.by)}</div>` : ""}
    </td>
  </tr>
</table>`;

      case "item":
        return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;">
  <tr>
    <td style="border-left:3px solid ${palette.accent};padding:2px 0 2px 16px;">
      <div class="em-text" style="font-family:${monoStack};font-size:13px;line-height:1.6;color:${palette.text};">${inlineHtml(block.title)}</div>
      ${block.excerpt ? `<div class="em-muted" style="margin-top:4px;font-family:${monoStack};font-size:12px;line-height:1.6;color:${palette.textMuted};white-space:pre-wrap;">${escapeHtml(block.excerpt)}</div>` : ""}
      <div style="margin-top:5px;font-family:${monoStack};font-size:12px;"><a href="${escapeHtml(block.url)}" class="em-link" style="color:${palette.accentDark};text-decoration:underline;">${escapeHtml(block.linkLabel ?? "Open")}&nbsp;&#8250;</a></div>
    </td>
  </tr>
</table>`;

      case "note":
        return `<p class="em-muted" style="${noteStyle}">${inlineHtml(block.value)}</p>`;

      case "subheading":
        return `<div class="em-muted" style="margin:0 0 12px 0;font-family:${monoStack};font-size:11px;font-weight:700;letter-spacing:2px;color:${palette.textMuted};">${escapeHtml(block.value.toUpperCase())}</div>`;

      case "divider":
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px 0;"><tr><td class="em-border" style="border-top:1px solid ${palette.border};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
    }
  }

  /** The <style> block: only what inline CSS cannot express. */
  function styleBlock(): string {
    const d = palette.dark;
    // Both prefers-color-scheme (Apple Mail, Gmail apps) and [data-ogsc]/[data-ogsb]
    // (Outlook.com/Outlook apps rewrite classes with those prefixes) are covered.
    return `
  <style>
    a { text-decoration: none; }
    @media only screen and (max-width: 620px) {
      .em-container { width: 100% !important; }
      .em-card-pad { padding: 28px 22px !important; }
      .em-codechars { font-size: 26px !important; letter-spacing: 7px !important; text-indent: 7px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .em-bg { background: ${d.bodyBg} !important; }
      .em-card { background: ${d.cardBg} !important; border-color: ${d.border} !important; border-top-color: ${d.accent} !important; }
      .em-text { color: ${d.text} !important; }
      .em-muted { color: ${d.textMuted} !important; }
      .em-dim { color: ${d.textDim} !important; }
      .em-inset { background: ${d.insetBg} !important; border-color: ${d.insetBorder} !important; }
      .em-border { border-color: ${d.border} !important; }
      .em-link { color: ${d.accentLight} !important; }
      .em-codechars { color: ${d.text} !important; }
      .em-wordmark { color: ${d.text} !important; }
    }
    [data-ogsc] .em-text, [data-ogsc] .em-codechars, [data-ogsc] .em-wordmark { color: ${d.text} !important; }
    [data-ogsc] .em-muted { color: ${d.textMuted} !important; }
    [data-ogsc] .em-dim { color: ${d.textDim} !important; }
    [data-ogsc] .em-link { color: ${d.accentLight} !important; }
    [data-ogsb] .em-bg { background: ${d.bodyBg} !important; }
    [data-ogsb] .em-card { background: ${d.cardBg} !important; border-color: ${d.border} !important; border-top-color: ${d.accent} !important; }
    [data-ogsb] .em-inset { background: ${d.insetBg} !important; border-color: ${d.insetBorder} !important; }
  </style>`;
  }

  return function renderEmail(def: EmailDef, opts?: RenderOptions): RenderedEmail {
    const year = opts?.year ?? new Date().getFullYear();

    const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(def.subject)}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
${styleBlock()}
</head>
<body class="em-bg" style="margin:0;padding:0;background:${palette.bodyBg};">
  <!-- Inbox preview text; invisible in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(def.preheader)}${"&#8199;&#65279;&#847; ".repeat(24)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="em-bg" style="background:${palette.bodyBg};">
    <tr>
      <td align="center" style="padding:36px 14px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="em-container" style="width:600px;max-width:600px;">

          <!-- Wordmark -->
          <tr>
            <td style="padding:0 6px 14px 6px;">
              <a href="${brand.url}" target="_blank" style="text-decoration:none;">
                <span style="font-family:${monoStack};font-size:17px;font-weight:700;color:${palette.accent};">${brand.logo.glyph}</span>
                <span class="em-wordmark" style="font-family:${monoStack};font-size:17px;font-weight:700;letter-spacing:0.5px;color:${palette.text};">${escapeHtml(brand.logo.text)}</span>
              </a>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td class="em-card" style="background:${palette.cardBg};border:1px solid ${palette.border};border-top:3px solid ${palette.accent};border-radius:14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td class="em-card-pad" style="padding:36px 40px 24px 40px;">
                    ${
                      def.eyebrow
                        ? `<div style="font-family:${monoStack};font-size:11px;font-weight:700;letter-spacing:2.5px;color:${palette.accent};margin:0 0 14px 0;">${escapeHtml(def.eyebrow.toUpperCase())}</div>`
                        : ""
                    }
                    <h1 class="em-text" style="margin:0 0 18px 0;font-family:${monoStack};font-size:21px;line-height:1.35;font-weight:700;color:${palette.text};">${escapeHtml(def.heading)}</h1>
                    ${def.blocks.map(renderBlockHtml).join("\n")}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:22px 6px 0 6px;">
              <p class="em-dim" style="margin:0 0 6px 0;font-family:${monoStack};font-size:11px;line-height:1.7;color:${palette.textDim};">${inlineHtml(def.reason, "em-dim")}</p>
              <p class="em-dim" style="margin:0;font-family:${monoStack};font-size:11px;line-height:1.7;color:${palette.textDim};">
                <a href="${brand.url}" class="em-dim" style="color:${palette.textDim};text-decoration:underline;">${escapeHtml(brand.host)}</a>
                &nbsp;&middot;&nbsp; ${escapeHtml(brand.tagline.toLowerCase())}
                &nbsp;&middot;&nbsp; &copy; ${year} ${escapeHtml(brand.name)}
              </p>
            </td>
          </tr>

        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = [
      `${brand.name.toUpperCase()} — ${def.heading}`,
      "",
      ...def.blocks
        .map(renderBlockText)
        .filter((s) => s !== "")
        .flatMap((s) => [s, ""]),
      "--",
      inlineText(def.reason),
      `${brand.url} · ${brand.tagline}`,
    ].join("\n");

    return { subject: def.subject, html, text };
  };
}

/** One shot form of `createRenderer(brand)(def, opts)`. */
export function renderEmail(def: EmailDef, brand: Brand, opts?: RenderOptions): RenderedEmail {
  return createRenderer(brand)(def, opts);
}
