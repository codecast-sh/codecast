"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import { MarkdownRenderer } from "../../../../components/tools/MarkdownRenderer";

const DOC_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  plan: { label: "Plan", color: "text-sol-blue" },
  design: { label: "Design", color: "text-sol-violet" },
  spec: { label: "Spec", color: "text-sol-cyan" },
  investigation: { label: "Investigation", color: "text-sol-yellow" },
  handoff: { label: "Handoff", color: "text-sol-orange" },
  note: { label: "Note", color: "text-sol-text-muted" },
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function InvalidLink() {
  return (
    <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
      <div className="text-center max-w-md px-4">
        <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        <h1 className="text-xl text-sol-base0 mb-2">Invalid Link</h1>
        <p className="text-sol-base00 text-sm">
          This share link is invalid or the document has been made private.
        </p>
      </div>
    </main>
  );
}

export default function SharedDocClient() {
  const params = useParams();
  const token = params.token as string;

  const doc = useQuery((api as any).docs.getShared, { share_token: token });

  if (doc === undefined) {
    return (
      <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
        <div className="text-sol-text-dim text-sm">Loading...</div>
      </main>
    );
  }

  if (doc === null) return <InvalidLink />;

  const typeInfo = DOC_TYPE_LABELS[doc.doc_type] || DOC_TYPE_LABELS.note;

  return (
    <main className="min-h-screen bg-sol-base03">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <span className={`text-xs font-medium px-2 py-0.5 rounded border border-current/20 ${typeInfo.color}`}>
              {typeInfo.label}
            </span>
            {doc.labels?.map((l: string) => (
              <span key={l} className="text-xs text-sol-text-dim px-1.5 py-0.5 rounded border border-sol-border/30">
                {l}
              </span>
            ))}
          </div>
          <h1 className="text-2xl font-semibold text-sol-text mb-3">{doc.title}</h1>
          <div className="flex items-center gap-3 text-xs text-sol-text-dim">
            {doc.user?.image && (
              <img src={doc.user.image} alt="" className="w-5 h-5 rounded-full" />
            )}
            {doc.user?.name && <span className="text-sol-text-muted">{doc.user.name}</span>}
            <span>{formatDate(doc.created_at)}</span>
            {doc.updated_at !== doc.created_at && (
              <span>Updated {formatDate(doc.updated_at)}</span>
            )}
          </div>
        </div>

        {/* Content */}
        <article className="prose prose-invert max-w-none">
          <MarkdownRenderer content={doc.content} />
        </article>

        {/* Entries/Comments */}
        {doc.entries && doc.entries.length > 0 && (
          <div className="mt-12 border-t border-sol-border/20 pt-8">
            <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-4">Timeline</h2>
            <div className="space-y-3">
              {doc.entries.map((e: any, i: number) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="text-sol-text-dim shrink-0 w-16">{formatDate(e.timestamp)}</span>
                  <span className="text-xs text-sol-cyan/70 shrink-0 w-20">{e.type}</span>
                  <span className="text-sol-text-muted">{e.content}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-16 pt-6 border-t border-sol-border/10 text-center">
          <a href="https://codecast.sh" className="text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors">
            Shared via Codecast
          </a>
        </div>
      </div>
    </main>
  );
}
