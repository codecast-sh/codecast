import { prepareInjectedContent } from "../tmuxPaste.js";

export function sanitizeForTerminal(content: string): string {
  return prepareInjectedContent(content, { bracketed: true }).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
