"use client";
// A step's prompt (line-workspace.md LW3), ported from Studio's prompt view:
// an outline of sections, each folded to its first sentence and opened in
// place, the shared sections it pulls in folded where they sit, and each
// inserted value said in words and linked to the step it comes from. Edit
// mode is a plain text area that emits the new text; saving and trying it
// belong to the actions (LW4), which read the draft the caller keeps.
import { memo, useMemo, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { MarkdownBlocks } from "../../tools/MarkdownRenderer";
import { readableTemplate, stationRefOf } from "../../../lib/line/lineGraphs";
import type { PromptInclude, StepPrompt } from "../../../lib/line/lineModel";
import { promptParts, promptSections } from "../../../lib/line/promptText";
import { useLineNav } from "./parts";

type NodeName = { id: string; label: string };

/** A link to another step inside a prompt opens that step. */
function StepRefLink({ href, children }: { href?: string; children?: ReactNode }) {
  const nav = useLineNav();
  const step = stationRefOf(href);
  if (!step) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  return (
    <a
      className="lw-stepref"
      href={nav.stepHref(step) ?? href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        nav.openStep(step);
      }}
    >
      {children}
    </a>
  );
}

// Module-level, so react-markdown's parse is cached across renders.
const PROMPT_MD: Components = { a: ({ href, children }) => <StepRefLink href={href}>{children}</StepRefLink> };

/** One stretch of prompt text, its inserted values said in words. */
const PromptMarkdown = memo(function PromptMarkdown({ text, nodes }: { text: string; nodes: ReadonlyArray<NodeName> }) {
  const readable = useMemo(() => readableTemplate(text, nodes), [text, nodes]);
  return <MarkdownBlocks content={readable} components={PROMPT_MD} />;
});

function Include({ include }: { include: PromptInclude | undefined; name: string }) {
  const text = include?.text ?? null;
  const name = include?.name ?? "";
  if (text == null) {
    return (
      <details className="lw-include" data-missing="">
        <summary><span className="lw-plus" aria-hidden>+</span><b>{name}</b><span>shared text; its words are not recorded with the runs</span></summary>
      </details>
    );
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return (
    <details className="lw-include">
      <summary><span className="lw-plus" aria-hidden>+</span><b>{name}</b><span>shared text, {words} words</span></summary>
      <div className="lw-include-body lw-doc"><PromptMarkdown text={text} nodes={[]} /></div>
    </details>
  );
}

/** A stretch of text with its shared sections folded in place. */
function PromptBody({ text, includes, nodes }: { text: string; includes: ReadonlyArray<PromptInclude>; nodes: ReadonlyArray<NodeName> }) {
  const parts = useMemo(() => promptParts(text), [text]);
  return (
    <div className="lw-doc">
      {parts.map((p, i) => p.kind === "include"
        ? <Include key={`i${i}`} name={p.name} include={includes.find((x) => x.name === p.name) ?? { name: p.name, from: p.from, text: null }} />
        : <PromptMarkdown key={`t${i}`} text={p.text} nodes={nodes} />)}
    </div>
  );
}

export type PromptViewProps = {
  prompt: StepPrompt;
  /** The graph's steps, so an inserted value names the step it comes from. */
  nodes?: ReadonlyArray<NodeName>;
  /** The text to show instead of the prompt's own (an unsaved edit). */
  text?: string | null;
  /** Line numbers of `text` an edit added: their sections open and show changed. */
  changed?: ReadonlySet<number> | null;
  /** "outline" folds sections (the drawer); "flat" reads straight through; "peek" is a clamped preview. */
  layout?: "outline" | "flat" | "peek";
  editing?: boolean;
  onEdit?: (text: string) => void;
};

/** A prompt read as an outline, or edited as text. */
export function PromptView({ prompt, nodes = [], text, changed, layout = "outline", editing, onEdit }: PromptViewProps) {
  const shown = text ?? prompt.text;
  const [openAll, setOpenAll] = useState(false);
  const sections = useMemo(() => (layout === "outline" ? promptSections(shown) : []), [layout, shown]);

  if (editing) {
    return (
      <textarea
        className="lw-raw"
        spellCheck={false}
        value={shown}
        onChange={(e) => onEdit?.(e.target.value)}
        aria-label="Prompt text"
        autoFocus
        data-line-prompt-edit
      />
    );
  }
  if (prompt.kind === "script") return <pre className="lw-cmd" data-line-prompt="script">{shown}</pre>;
  if (layout !== "outline" || sections.length <= 1) {
    return (
      <div className={layout === "peek" ? "lw-clamp" : undefined} data-line-prompt={layout}>
        <PromptBody text={shown} includes={prompt.includes} nodes={nodes} />
      </div>
    );
  }
  return (
    <div data-line-prompt="outline">
      {sections.length > 2 && (
        <div className="lw-doctools" style={{ justifyContent: "flex-end", marginTop: -6 }}>
          <button type="button" className="lw-link" onClick={() => setOpenAll((v) => !v)} aria-pressed={openAll}>{openAll ? "Fold all" : "Open all"}</button>
        </div>
      )}
      <div className="lw-outline">
        {sections.map((s) => {
          const isChanged = !!changed && [...changed].some((n) => n >= s.start && n < s.end);
          return (
            <details key={`${s.start}:${openAll}`} className="lw-psec" open={openAll || isChanged || sections.length === 1} data-changed={isChanged ? "" : undefined}>
              <summary>
                <span className="lw-chev" aria-hidden />
                <b>{s.title}</b>
                <span className="lw-psec-lead">{s.lead}</span>
                <span className="lw-psec-wc">{isChanged ? "changed" : `${s.words} words`}</span>
              </summary>
              <div className="lw-psec-body"><PromptBody text={s.body} includes={prompt.includes} nodes={nodes} /></div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
