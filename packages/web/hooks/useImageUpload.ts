import { useCallback } from "react";
import { useMutation, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { compressImage } from "../lib/compressImage";

const api = _api as any;

export function useImageUpload() {
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);

  return useCallback(async (file: File): Promise<string | null> => {
    const uploaded = await compressImage(file);
    const uploadUrl = await generateUploadUrl({});
    const result = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": uploaded.type },
      body: uploaded,
    });
    const { storageId } = await result.json();
    const url = await convex.query(api.images.getImageUrl, { storageId });
    return url || null;
  }, [generateUploadUrl, convex]);
}
