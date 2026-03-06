"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Badge } from "../../components/ui/badge";
import {
  FileText,
  Search,
  Pin,
  Archive,
  Clock,
  Filter,
  X,
} from "lucide-react";

const DOC_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  plan: { label: "Plan", color: "text-sol-blue" },
  design: { label: "Design", color: "text-sol-violet" },
  spec: { label: "Spec", color: "text-sol-cyan" },
  investigation: { label: "Investigation", color: "text-sol-yellow" },
  handoff: { label: "Handoff", color: "text-sol-orange" },
  note: { label: "Note", color: "text-sol-text-muted" },
};

function DocRow({ doc, onClick }: { doc: any; onClick: () => void }) {
  const type = DOC_TYPE_CONFIG[doc.doc_type] || DOC_TYPE_CONFIG.note;
  const age = Date.now() - doc.updated_at;
  const ageStr = age < 3600000
    ? `${Math.round(age / 60000)}m`
    : age < 86400000
      ? `${Math.round(age / 3600000)}h`
      : `${Math.round(age / 86400000)}d`;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors text-left group border-b border-sol-border/30"
    >
      <FileText className={`w-4 h-4 flex-shrink-0 ${type.color}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-sol-text truncate">{doc.title}</span>
          {doc.pinned && <Pin className="w-3 h-3 text-sol-yellow flex-shrink-0" />}
        </div>
        {doc.content && (
          <p className="text-xs text-sol-text-dim truncate mt-0.5">
            {doc.content.slice(0, 120).replace(/\n/g, " ")}
          </p>
        )}
      </div>
      {doc.labels?.map((l: string) => (
        <Badge key={l} variant="outline" className="text-[10px] px-1.5 py-0 border-sol-border/50 text-sol-text-dim">
          {l}
        </Badge>
      ))}
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${type.color} border-current/30`}>
        {type.label}
      </Badge>
      <span className="text-xs text-sol-text-dim w-8 text-right tabular-nums flex-shrink-0">{ageStr}</span>
    </button>
  );
}

function DocViewer({ doc, onClose }: { doc: any; onClose: () => void }) {
  const type = DOC_TYPE_CONFIG[doc.doc_type] || DOC_TYPE_CONFIG.note;
  const updateDoc = useMutation(api.docs.webUpdate);

  const handlePin = useCallback(async () => {
    await updateDoc({ id: doc._id, pinned: !doc.pinned });
  }, [doc._id, doc.pinned, updateDoc]);

  const handleArchive = useCallback(async () => {
    await updateDoc({ id: doc._id, archived: true });
    onClose();
  }, [doc._id, updateDoc, onClose]);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-[8vh]" onClick={onClose}>
      <div
        className="bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-sol-bg border-b border-sol-border/30 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={`text-xs ${type.color} border-current/30`}>
              {type.label}
            </Badge>
            <h2 className="text-lg font-semibold text-sol-text">{doc.title}</h2>
            {doc.pinned && <Pin className="w-4 h-4 text-sol-yellow" />}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePin}
              className="p-1.5 rounded-lg text-sol-text-dim hover:text-sol-yellow transition-colors"
              title={doc.pinned ? "Unpin" : "Pin"}
            >
              <Pin className="w-4 h-4" />
            </button>
            <button
              onClick={handleArchive}
              className="p-1.5 rounded-lg text-sol-text-dim hover:text-sol-red transition-colors"
              title="Archive"
            >
              <Archive className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-sol-text-dim hover:text-sol-text transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="px-6 py-4">
          {doc.labels?.length > 0 && (
            <div className="flex gap-1.5 mb-3">
              {doc.labels.map((l: string) => (
                <Badge key={l} variant="outline" className="text-xs">{l}</Badge>
              ))}
            </div>
          )}
          <div className="text-sm text-sol-text whitespace-pre-wrap font-mono leading-relaxed">
            {doc.content}
          </div>
          <div className="mt-6 pt-4 border-t border-sol-border/20 flex items-center gap-4 text-xs text-sol-text-dim">
            <span>Source: {doc.source}</span>
            {doc.source_file && <span className="font-mono truncate">{doc.source_file}</span>}
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {new Date(doc.updated_at).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DocsPage() {
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<any>(null);

  const docs = useQuery(
    searchQuery ? api.docs.webSearch : api.docs.webList,
    searchQuery
      ? { query: searchQuery, doc_type: typeFilter || undefined }
      : { doc_type: typeFilter || undefined }
  );

  const docDetail = useQuery(
    api.docs.webGet,
    selectedDoc?._id ? { id: selectedDoc._id } : "skip"
  );

  return (
    <AuthGuard>
      <DashboardLayout hideSidebar>
        <div className="h-full flex flex-col">
          <div className="px-6 py-4 border-b border-sol-border/30">
            <div className="flex items-center justify-between mb-3">
              <h1 className="text-lg font-semibold text-sol-text tracking-tight">Documents</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sol-text-dim" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search documents..."
                  className="w-full text-sm pl-9 pr-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
                />
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setTypeFilter("")}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                    !typeFilter ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                  }`}
                >
                  All
                </button>
                {Object.entries(DOC_TYPE_CONFIG).map(([key, cfg]) => (
                  <button
                    key={key}
                    onClick={() => setTypeFilter(key)}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      typeFilter === key ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                    }`}
                  >
                    {cfg.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!docs ? (
              <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">Loading...</div>
            ) : docs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-sol-text-dim">
                <FileText className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No documents found</p>
                <p className="text-xs mt-1">Sync plan files with: codecast doc sync</p>
              </div>
            ) : (
              docs.map((d: any) => (
                <DocRow key={d._id} doc={d} onClick={() => setSelectedDoc(d)} />
              ))
            )}
          </div>
        </div>

        {selectedDoc && docDetail && (
          <DocViewer doc={docDetail} onClose={() => setSelectedDoc(null)} />
        )}
      </DashboardLayout>
    </AuthGuard>
  );
}
