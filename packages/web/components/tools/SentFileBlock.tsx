// The card a file gets when an agent hands it to the human.
//
// `SendUserFile` delivers a file to whatever client the person is sitting in
// front of. The daemon uploads the bytes on the way through (see the CLI's
// userFiles.ts), so by the time the tool call reaches this component the file
// is in storage and the card can do the three things the person actually wants:
// see what arrived, look at it without leaving the thread, and save it under
// its real name.
//
// A delivery that could not be carried still renders. The agent already told
// the human it sent something, so a card explaining "42 MB, too large to
// attach" beats a tool block that silently shows nothing.

import { memo, useCallback, useState } from "react";
import { fileKind, formatFileSize, fileTypeLabel, isPreviewableKind, type FileKind } from "@codecast/shared/files";
import { useStorageImageUrl } from "../../hooks/useStorageImageUrl";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useImageGallery } from "../ImageGallery";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CodeBlock } from "../CodeBlock";

export type SentFileData = {
  name: string;
  media_type: string;
  size?: number;
  storage_id?: string;
  tool_use_id?: string;
  caption?: string;
  display?: string;
  error?: string;
};

/** Accent per kind, so the badge reads as a type before the name is read. */
const KIND_ACCENT: Record<FileKind, string> = {
  image: "text-sol-magenta border-sol-magenta/30 bg-sol-magenta/10",
  pdf: "text-sol-red border-sol-red/30 bg-sol-red/10",
  video: "text-sol-violet border-sol-violet/30 bg-sol-violet/10",
  audio: "text-sol-violet border-sol-violet/30 bg-sol-violet/10",
  text: "text-sol-cyan border-sol-cyan/30 bg-sol-cyan/10",
  sheet: "text-sol-green border-sol-green/30 bg-sol-green/10",
  doc: "text-sol-blue border-sol-blue/30 bg-sol-blue/10",
  archive: "text-sol-yellow border-sol-yellow/30 bg-sol-yellow/10",
  binary: "text-sol-text-muted border-sol-border bg-sol-bg-alt",
};

const ERROR_TEXT: Record<string, string> = {
  too_large: "too large to attach",
  missing: "the file was gone when this synced",
  upload_failed: "the upload did not go through",
};

/** Largest text preview we will fetch and render inline. */
const MAX_TEXT_PREVIEW_BYTES = 400_000;

function DownloadButton({ url, name }: { url: string; name: string }) {
  const [saving, setSaving] = useState(false);
  // Storage lives on another origin, where the `download` attribute is ignored
  // and the file would save under its storage id. Fetching the bytes and
  // saving a blob URL is what keeps the human's copy named `report.pdf`.
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      // Falls back to the plain link, which at least opens the file.
      window.open(url, "_blank", "noopener");
    } finally {
      setSaving(false);
    }
  }, [url, name]);

  return (
    <button
      onClick={save}
      disabled={saving}
      className="px-2 py-1 rounded text-[11px] font-medium text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt border border-sol-border transition-colors disabled:opacity-50"
      title={`Save ${name}`}
    >
      {saving ? "Saving…" : "Download"}
    </button>
  );
}

/** Text and markdown read in the thread; everything else the browser handles. */
function TextPreview({ url, name, kind }: { url: string; name: string; kind: "markdown" | "code" }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useWatchEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch(url);
        const body = await response.text();
        if (live) setText(body.slice(0, MAX_TEXT_PREVIEW_BYTES));
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [url]);

  if (failed) return <div className="px-3 py-2 text-xs text-sol-text-dim">Could not read this file.</div>;
  if (text === null) return <div className="px-3 py-2 text-xs text-sol-text-dim">Loading…</div>;
  if (kind === "markdown") {
    return (
      <div className="px-3 py-2 max-h-[32rem] overflow-auto">
        <MarkdownRenderer content={text} />
      </div>
    );
  }
  return (
    <div className="max-h-[32rem] overflow-auto">
      <CodeBlock code={text} language={name.split(".").pop() ?? "text"} />
    </div>
  );
}

const FileCard = memo(function FileCard({ file, soloFile }: { file: SentFileData; soloFile: boolean }) {
  const kind = fileKind(file.media_type, file.name);
  const url = useStorageImageUrl(file.storage_id);
  const gallery = useImageGallery();
  // `display: "render"` is the sender saying the content IS the message, so a
  // single file opens with its card. Several files stay closed: four open
  // previews is a wall to scroll past, not a delivery you can read.
  const [open, setOpen] = useState(file.display === "render" && soloFile);

  const label = fileTypeLabel(file.name, file.media_type);
  const size = file.size ? formatFileSize(file.size) : "";
  const previewable = isPreviewableKind(kind) && !!url;
  const isMarkdown = file.media_type === "text/markdown";

  const meta = [label, size].filter(Boolean).join(" · ");
  // No storage id and no error only happens mid-flight on a row written before
  // its upload finished; either way there is nothing to open yet.
  const undelivered = !!file.error || (!file.storage_id && !url);

  return (
    <div className={`my-2 max-w-2xl rounded-lg border overflow-hidden ${undelivered ? "border-dashed border-sol-border/60 bg-transparent" : "border-sol-border bg-sol-card"}`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        {kind === "image" && url ? (
          <button
            onClick={() => gallery?.open(url)}
            className="w-11 h-11 rounded border border-sol-border overflow-hidden flex-shrink-0 hover:border-sol-magenta/50 transition-colors"
            title="Open image"
          >
            <img src={url} alt={file.name} className="w-full h-full object-cover" />
          </button>
        ) : (
          <div
            className={`w-11 h-11 rounded border flex items-center justify-center flex-shrink-0 text-[10px] font-semibold tracking-wide ${KIND_ACCENT[kind]}`}
          >
            {label.slice(0, 4)}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-sol-text truncate" title={file.name}>{file.name}</div>
          <div className="text-[11px] text-sol-text-dim tabular-nums">
            {undelivered ? `${meta} — ${ERROR_TEXT[file.error ?? ""] ?? "not attached"}` : meta}
          </div>
        </div>

        {url && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {previewable && kind !== "image" && (
              <button
                onClick={() => setOpen(v => !v)}
                className="px-2 py-1 rounded text-[11px] font-medium text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt border border-sol-border transition-colors"
              >
                {open ? "Hide" : "Preview"}
              </button>
            )}
            <DownloadButton url={url} name={file.name} />
          </div>
        )}
      </div>

      {open && url && kind === "pdf" && (
        <object data={url} type="application/pdf" className="w-full h-[32rem] border-t border-sol-border bg-sol-bg-alt">
          <div className="px-3 py-2 text-xs text-sol-text-dim">
            This browser will not preview PDFs inline. Use Download.
          </div>
        </object>
      )}
      {open && url && kind === "video" && (
        <video src={url} controls className="w-full max-h-[32rem] border-t border-sol-border bg-black" />
      )}
      {open && url && kind === "audio" && (
        <audio src={url} controls className="w-full border-t border-sol-border px-3 py-2" />
      )}
      {open && url && kind === "text" && (
        <div className="border-t border-sol-border bg-sol-bg-alt">
          <TextPreview url={url} name={file.name} kind={isMarkdown ? "markdown" : "code"} />
        </div>
      )}
    </div>
  );
});

/**
 * Every file one SendUserFile call delivered, under the caption it was sent
 * with. The caption belongs to the call, not to each file, so it is written
 * once above the cards.
 */
export const SentFileBlock = memo(function SentFileBlock({ files }: { files: SentFileData[] }) {
  if (files.length === 0) return null;
  const caption = files.find(f => f.caption)?.caption;
  return (
    <div className="my-2">
      <div className="flex items-center gap-1.5 text-[11px] text-sol-text-dim mb-1">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" />
        </svg>
        <span>{files.length === 1 ? "Sent you a file" : `Sent you ${files.length} files`}</span>
      </div>
      {caption && <div className="text-sm text-sol-text-muted mb-1.5">{caption}</div>}
      {files.map((file, i) => (
        <FileCard key={`${file.storage_id ?? file.name}-${i}`} file={file} soloFile={files.length === 1} />
      ))}
    </div>
  );
});
