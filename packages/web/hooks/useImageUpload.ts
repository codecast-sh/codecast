import { useCallback } from "react";
import { useMutation, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;

export function useImageUpload() {
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);

  return useCallback(async (file: File): Promise<string | null> => {
    const uploadUrl = await generateUploadUrl({});
    const result = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    const { storageId } = await result.json();
    const url = await convex.query(api.images.getImageUrl, { storageId });
    return url || null;
  }, [generateUploadUrl, convex]);
}
