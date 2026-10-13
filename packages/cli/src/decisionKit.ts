// The decision page kit (docs/line/decision-kit/README.md): the stylesheet and
// script a decision's report page is built from, so a session writes the page's
// content and never its CSS.
//
// A page asks for the kit with one line in its <head>:
//
//   <link rel="stylesheet" href="cast:decision-kit">
//
// `cast publish` and `cast decide --report` replace that line with the kit
// itself, inline, so the published page is one file that keeps the kit it was
// written against. `cast decide kit` prints the guide, and `cast decide kit
// <page.html>` writes the page as it will be served, for a look before posting.
import kitCss from "../kit/decision-kit.css" with { type: "text" };
import kitJs from "../kit/decision-kit.js" with { type: "text" };
import kitGuide from "../../../docs/line/decision-kit/README.md" with { type: "text" };
import { injectPageTheme } from "@codecast/shared/render";

export const DECISION_KIT_LINE = '<link rel="stylesheet" href="cast:decision-kit">';
export const DECISION_KIT_GUIDE: string = kitGuide;

const KIT_TAG = /<link\b[^>]*\bhref\s*=\s*["']cast:decision-kit["'][^>]*>/gi;

/** Whether the page asks for the kit. */
export function usesDecisionKit(html: string): boolean {
  KIT_TAG.lastIndex = 0;
  return KIT_TAG.test(html);
}

/** The page with its kit line replaced by the kit, inline. A page without the line is returned as it is. */
export function inlineDecisionKit(html: string): string {
  let done = false;
  return html.replace(KIT_TAG, () => {
    if (done) return "";
    done = true;
    return `<style data-decision-kit>\n${kitCss}</style>\n<script data-decision-kit>\n${kitJs.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
}

/** The page as codecast serves it: the kit inline and the colour tokens in its head. */
export function previewDecisionPage(html: string): string {
  return injectPageTheme(inlineDecisionKit(html));
}
