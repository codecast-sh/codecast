import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { compressImage } from "../lib/compressImage";
import { uploadBlobToStorage } from "../lib/uploadBlob";

const api = _api as any;

export function useImageUpload() {
  const convex = useConvex();

  return useCallback(async (file: File): Promise<string | null> => {
    const uploaded = await compressImage(file);
    const storageId = await uploadBlobToStorage(convex, uploaded, uploaded.type);
    if (!storageId) return null;
    const url = await convex.query(api.images.getImageUrl, { storageId });
    return url || null;
  }, [convex]);
}
