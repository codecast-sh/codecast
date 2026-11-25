// A small card at the editor's top right for the outcome of something that
// reached beyond the cursor: a rename across files (and any file it could not
// write), a definition outside the folder. It goes away by itself unless it
// lists something to act on.

import type { EditorView } from "@codemirror/view";
import { el } from "./list";

export interface NoticeRow {
  label: string;
  hint?: string;
  tone?: "error" | "warning";
  onClick?(): void;
}

export interface NoticeSpec {
  tone: "ok" | "warn" | "error";
  title: string;
  rows?: NoticeRow[];
  /** Kept until dismissed when set, or when there are rows. */
  sticky?: boolean;
}

const shown = new WeakMap<EditorView, () => void>();

export function showNotice(view: EditorView, spec: NoticeSpec): void {
  shown.get(view)?.();
  const root = el("div", "cm-lsp-overlay cm-lsp-notice");
  root.dataset.tone = spec.tone;
  root.setAttribute("role", "status");
  const head = el("div", "cm-lsp-notice-head");
  const dismiss = el("button", undefined, "×");
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Dismiss");
  const title = el("span", "cm-lsp-label", spec.title);
  title.style.flex = "1";
  head.append(el("span", "cm-lsp-notice-dot"), title, dismiss);
  root.append(head);
  for (const row of spec.rows ?? []) {
    const r = el("div", "cm-lsp-row");
    if (row.tone) r.append(el("span", `cm-lsp-kind cm-lsp-sev-${row.tone}`, row.tone === "error" ? "✕" : "!"));
    r.append(el("span", "cm-lsp-label", row.label));
    if (row.hint) r.append(el("span", "cm-lsp-hint", row.hint));
    if (row.onClick) r.onclick = () => row.onClick!();
    else r.style.cursor = "default";
    root.append(r);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const remove = () => {
    if (timer) clearTimeout(timer);
    root.remove();
    if (shown.get(view) === remove) shown.delete(view);
  };
  dismiss.onclick = remove;
  if (!spec.sticky && !spec.rows?.length) timer = setTimeout(remove, 3500);
  shown.set(view, remove);
  view.dom.appendChild(root);
}
