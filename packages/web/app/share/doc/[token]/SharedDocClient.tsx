"use client";
import { docTypeLabel, stripTitleHeading } from "@codecast/shared/docs";
import { api } from "@codecast/convex/convex/_generated/api";
import { AvatarImg } from "../../../../lib/avatarCache";
import { MarkdownRenderer } from "../../../../components/tools/MarkdownRenderer";
import { SharedObjectPage } from "../../SharedObjectPage";
import { DocDates } from "../../../../components/DocDates";
import { docTypeStyle } from "../../../../lib/docTypeStyle";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";

export default function SharedDocClient() {
  return (
    <SharedObjectPage<any> kind="doc" query={(api as any).docs.getShared} noun="document">
      {(doc) => (
          <>
            {/* Header */}
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <span className={`text-xs font-medium px-2 py-0.5 rounded border border-current/20 ${docTypeStyle(doc.doc_type).color}`}>
                  {docTypeLabel(doc.doc_type)}
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
                  <AvatarImg src={doc.user.image} alt="" className="w-5 h-5 rounded-full" />
                )}
                {doc.user?.name && <span className="text-sol-text-muted">{doc.user.name}</span>}
                <DocDates doc={doc} variant="full" />
              </div>
            </div>

            {/* Content */}
            <article className="prose prose-invert max-w-none">
              <MarkdownRenderer content={stripTitleHeading(doc.content)} />
            </article>

            {/* Entries/Comments */}
            {doc.entries && doc.entries.length > 0 && (
              <div className="mt-12 border-t border-sol-border/20 pt-8">
                <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-4">Timeline</h2>
                <div className="space-y-3">
                  {doc.entries.map((e: any, i: number) => (
                    <div key={i} className="flex gap-3 text-sm">
                      <span className="text-sol-text-dim shrink-0 w-20" title={formatDateFull(e.timestamp)}>{formatDateSmart(e.timestamp)}</span>
                      <span className="text-xs text-sol-cyan/70 shrink-0 w-20">{e.type}</span>
                      <span className="text-sol-text-muted">{e.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
      )}
    </SharedObjectPage>
  );
}
