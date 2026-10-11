import { Suspense, lazy, type ReactNode } from "react";
import { CodeBlock } from "../components/CodeBlock";
import { MermaidDiagram } from "../components/MermaidDiagram";
import { tryRenderCanvas } from "../components/HtmlSnippet";
import { tryRenderCastDiff } from "../components/InlineDiff";
import { ModFence } from "../components/mods/ModSurface";
import { LINE_FENCE_LANG } from "./line/lineFence";

// A line widget (docs/architecture/line-workspace.md LW3) reads a project's
// line from the store, so its code loads only where a ```line block appears.
const LineFence = lazy(() => import("../components/line/widgets/LineFence"));

// The one place a fenced block becomes something richer than code. Every
// markdown pipeline (messages, docs, cards, comments, a mod's own Markdown)
// draws ```<lang> through renderFence, so a block type added here (or by an
// enabled mod declaring a fence) draws the same everywhere at once.

export function extractTextFromHast(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (node.children) return node.children.map(extractTextFromHast).join("");
  return "";
}

export function renderFence(language: string | undefined, code: string, opts: { mermaid?: boolean } = {}): ReactNode {
  if (opts.mermaid && language === "mermaid") return <MermaidDiagram code={code} />;
  const canvas = tryRenderCanvas(language, code);
  if (canvas) return canvas;
  const castDiff = tryRenderCastDiff(language, code);
  if (castDiff) return castDiff;
  if (language === LINE_FENCE_LANG) return <Suspense fallback={<div className="my-2 h-24 max-w-[860px] rounded-xl border border-sol-border/30 bg-sol-bg-alt/40" aria-busy />}><LineFence code={code} /></Suspense>;
  // Any other language may be one an enabled mod draws, now or once mods load:
  // ModFence follows the running set and stays a plain code block otherwise.
  return language ? <ModFence lang={language} code={code} /> : <CodeBlock code={code} language={language} />;
}

/** react-markdown's `pre` override: a fenced block goes through renderFence, anything else stays a pre. */
export function renderPre(node: any, children: ReactNode, props: any, opts: { mermaid?: boolean } = {}): ReactNode {
  const codeElement = node?.children?.[0];
  if (codeElement && codeElement.type === "element" && codeElement.tagName === "code") {
    const className = codeElement.properties?.className as string[] | undefined;
    const language = className?.find((cls) => cls.startsWith("language-"))?.replace("language-", "");
    const code = extractTextFromHast(codeElement);
    if (code) return renderFence(language, code, opts);
  }
  return <pre {...props}>{children}</pre>;
}
