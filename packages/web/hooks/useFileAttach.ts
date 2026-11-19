// Files attached in the web composer that are neither images nor screen
// recordings. Each uploads to storage at once; the send carries one tag per
// file (shared/contracts/fileAttachment), which the delivering daemon swaps
// for the path it saved the file to on the session's machine.
import { useCallback, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { appendFileTags } from "@codecast/shared/contracts";
import { uploadBlobToStorage } from "../lib/uploadBlob";

export type AttachedFile = { key: string; file: File; storageId: string | null };

let nextKey = 0;

export function useFileAttach() {
  const convex = useConvex();
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const current = useRef<AttachedFile[]>([]);
  current.current = files;

  const attach = useCallback((file: File) => {
    const key = `f${nextKey++}`;
    setFiles((prev) => [...prev, { key, file, storageId: null }]);
    void (async () => {
      const storageId = await uploadBlobToStorage(convex, file, file.type || "application/octet-stream");
      if (storageId) {
        setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, storageId: storageId as string } : f)));
      } else {
        toast.error(`Could not upload ${file.name}`);
        setFiles((prev) => prev.filter((f) => f.key !== key));
      }
    })();
  }, [convex]);

  const remove = useCallback((key: string) => {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }, []);

  /** The turn's text with a tag per uploaded file; the composer holds no
   *  files after it. */
  const take = useCallback((text: string): string => {
    const ready = current.current.filter((f) => f.storageId);
    if (ready.length === 0) return text;
    setFiles([]);
    current.current = [];
    return appendFileTags(text, ready.map((f) => ({ storageId: f.storageId!, name: f.file.name })));
  }, []);

  return { files, attach, remove, take, uploading: files.some((f) => !f.storageId) };
}
